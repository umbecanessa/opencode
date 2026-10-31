import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { FileAccess } from "@opencode/core/file-access"
import { Job } from "@opencode/core/job"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { PeerPlacements } from "@opencode/core/peer-placements"
import { PeerServers } from "@opencode/core/peer-servers"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { SessionTools } from "@opencode/core/tool/plugin/session"
import { Tool } from "@opencode/core/tool"
import { Workspace } from "@opencode/core/workspace"
import { Global } from "@opencode/util/global"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const remoteText = "remote final response"
const remoteSessionID = Session.ID.create()
const calls: { op: string; server: string; input: unknown }[] = []
let stopNotFound = false

const stubLayer = Layer.succeed(
  PeerServers.Service,
  PeerServers.Service.of({
    list: (server, input) =>
      Effect.sync(() => {
        calls.push({ op: "list", server, input })
        return [
          {
            id: remoteSessionID,
            title: "remote worker",
            model: "test/remote",
            directory: "/srv/other/project",
            active: true,
            updated: 1,
          },
        ]
      }),
    spawn: (server, input) =>
      server === "lab"
        ? Effect.sync(() => {
            calls.push({ op: "spawn", server, input })
            return { sessionID: remoteSessionID, text: remoteText, outcome: "succeeded" as const }
          })
        : Effect.fail(new PeerServers.Failure({ server, detail: "is not configured. Configured servers: lab" })),
    dispatch: (server, input) =>
      server === "lab"
        ? Effect.sync(() => {
            calls.push({ op: "dispatch", server, input })
            return { sessionID: remoteSessionID }
          })
        : Effect.fail(new PeerServers.Failure({ server, detail: "is not configured. Configured servers: lab" })),
    watch: (server, sessionID) =>
      Effect.sync(() => {
        calls.push({ op: "watch", server, input: sessionID })
        return remoteText
      }),
    send: (server, input) =>
      Effect.sync(() => {
        calls.push({ op: "send", server, input })
      }),
    stop: (server, input) =>
      stopNotFound
        ? Effect.fail(new PeerServers.Failure({ server, detail: "not found (HTTP 404)", notFound: true }))
        : Effect.sync(() => {
            calls.push({ op: "stop", server, input })
            return true
          }),
    wait: (server, sessionID) =>
      Effect.sync(() => {
        calls.push({ op: "wait", server, input: sessionID })
      }),
    outcome: () => Effect.succeed("succeeded" as const),
    names: Effect.succeed(["lab"] as const),
  }),
)

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.succeed(
    SessionExecution.Service,
    SessionExecution.Service.of({
      active: Effect.succeed(new Set()),
      activeCluster: Effect.succeed(new Set()),
      isActive: () => Effect.succeed(false),
      resume: () => Effect.void,
      wake: () => Effect.void,
      interrupt: () => Effect.succeed(false),
      awaitIdle: () => Effect.void,
    }),
  ),
  deps: [],
})

const sessionToolPluginSupervisor = makeLocationNode({
  name: "test/peer-server-tool-plugins",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* registerToolPlugin(SessionTools.Plugin, {}, (name, callback) => hooks.register("tool", name, callback))
    }),
  ),
  deps: [
    Agent.node,
    Config.node,
    FileAccess.node,
    Model.node,
    PeerPlacements.node,
    PeerServers.node,
    Permission.node,
    Session.node,
    Job.node,
    SubagentJob.node,
    Tool.node,
    Workspace.node,
    PluginHooks.node,
  ],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  LocationServiceMap.node,
])
const it = testEffect(
  AppNodeBuilder.build(nodes, [
    SessionExecution.node.replace(executionNode),
    Global.node.replace(tempGlobalLayer),
    PeerServers.node.replace(stubLayer),
    offlineModels,
    PluginSupervisor.node.replace(sessionToolPluginSupervisor),
  ]),
)

const withSessionTools = (location: Location.Ref) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(Effect.provide(locations.get(location)))
    yield* Agent.Service.use((agents) =>
      agents.transform((editor) => {
        editor.update(toolIdentity.agent, (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
        })
      }),
    ).pipe(Effect.provide(locations.get(location)))
  })

const withTools =
  <R>(run: (registry: Tool.Interface, sessionID: Session.ID) => Effect.Effect<void, never, R>) =>
  () =>
    Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((dir) =>
      Effect.gen(function* () {
        calls.length = 0
        stopNotFound = false
        const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, title: "Orchestrator" })
        yield* withSessionTools(location)
        const locations = yield* LocationServiceMap.Service
        const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(location)))
        yield* run(registry, parent.id)
      }),
    ),
  )

const call = (registry: Tool.Interface, sessionID: Session.ID, name: string, input: Record<string, unknown>) =>
  executeTool(registry, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call", id: `call-${name}-${calls.length}`, name, input },
  })

describe("SessionTools cross-server dispatch", () => {
  it.live(
    "spawns a session on the peer server and returns its final text",
    withTools((registry, sessionID) =>
      Effect.gen(function* () {
        const settled = yield* call(registry, sessionID, "opencode_session_spawn", {
          title: "remote work",
          prompt: "do the thing over there",
          server: "lab",
        })
        expect(settled.status).toBe("completed")
        expect(settled.metadata).toEqual({ sessionID: remoteSessionID, status: "completed" })
        expect(settled.content).toEqual([
          { type: "text", text: expect.stringContaining(`<peer sessionID="${remoteSessionID}"`) },
        ])
        expect(settled.content).toEqual([{ type: "text", text: expect.stringContaining(remoteText) }])
        expect(calls).toEqual([
          { op: "spawn", server: "lab", input: { title: "remote work", prompt: "do the thing over there" } },
        ])
      }),
    ),
  )

  it.live(
    "surfaces the configured-server list when dispatching to an unknown server",
    withTools((registry, sessionID) =>
      Effect.gen(function* () {
        const settled = yield* call(registry, sessionID, "opencode_session_spawn", {
          title: "nowhere",
          prompt: "hello",
          server: "nope",
        })
        expect(settled.status).toBe("error")
        expect(JSON.stringify(settled.error)).toContain("Configured servers: lab")
      }),
    ),
  )

  it.live(
    "dispatches a background peer session and routes a later send by session ID alone",
    withTools((registry, sessionID) =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
          Stream.filter((event) => event.data.sessionID === sessionID && event.data.item.type === "synthetic"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        )

        const spawned = yield* call(registry, sessionID, "opencode_session_spawn", {
          title: "bg remote",
          prompt: "go",
          server: "lab",
          background: true,
        })
        expect(spawned.status).toBe("completed")
        expect(spawned.output).toEqual({ sessionID: remoteSessionID, status: "running", output: expect.stringContaining("DO NOT sleep") })
        expect(calls.map((entry) => entry.op)).toContain("dispatch")

        // The watcher job settles with the remote outcome and notifies the parent.
        const admission = Array.from(yield* Fiber.join(admitted))[0]
        expect(admission?.data.item.type).toBe("synthetic")
        if (admission?.data.item.type === "synthetic") {
          expect(admission.data.item.payload.text).toContain(`<peer sessionID="${remoteSessionID}" state="completed"`)
          expect(admission.data.item.payload).toMatchObject({
            description: "bg remote",
            metadata: { source: "peer_remote", childID: remoteSessionID, state: "completed" },
          })
        }

        const sent = yield* call(registry, sessionID, "opencode_session_send", {
          sessionID: remoteSessionID,
          prompt: "keep going",
        })
        expect(sent.status).toBe("completed")
        expect(calls.filter((entry) => entry.op === "send")).toEqual([
          { op: "send", server: "lab", input: { sessionID: remoteSessionID, prompt: "keep going" } },
        ])
      }),
    ),
  )

  it.live(
    "drops the placement when the peer reports the dispatched session gone",
    withTools((registry, sessionID) =>
      Effect.gen(function* () {
        const settled = yield* call(registry, sessionID, "opencode_session_spawn", {
          title: "fg remote",
          prompt: "do it",
          server: "lab",
        })
        expect(settled.status).toBe("completed")

        stopNotFound = true
        const stopped = yield* call(registry, sessionID, "opencode_session_stop", { sessionID: remoteSessionID })
        expect(stopped.status).toBe("error")
        expect(JSON.stringify(stopped.error)).toContain("HTTP 404")

        const sent = yield* call(registry, sessionID, "opencode_session_send", {
          sessionID: remoteSessionID,
          prompt: "still there?",
        })
        expect(sent.status).toBe("error")
        expect(JSON.stringify(sent.error)).toContain("Session not found")
      }),
    ),
  )

  it.live(
    "lists peer sessions with remote activity",
    withTools((registry, sessionID) =>
      Effect.gen(function* () {
        const settled = yield* call(registry, sessionID, "opencode_session_list", { server: "lab" })
        expect(settled.status).toBe("completed")
        expect(settled.output.data).toEqual([
          {
            id: remoteSessionID,
            title: "remote worker",
            model: "test/remote",
            directory: "/srv/other/project",
            active: true,
            updated: 1,
          },
        ])
        expect(calls).toEqual([{ op: "list", server: "lab", input: {} }])
      }),
    ),
  )

  it.live(
    "sends, stops, and waits a remote session",
    withTools((registry, sessionID) =>
      Effect.gen(function* () {
        const sent = yield* call(registry, sessionID, "opencode_session_send", {
          sessionID: remoteSessionID,
          prompt: "keep going",
          server: "lab",
        })
        expect(sent.status).toBe("completed")
        expect(sent.output).toEqual({ sessionID: remoteSessionID, accepted: true })

        const stopped = yield* call(registry, sessionID, "opencode_session_stop", {
          sessionID: remoteSessionID,
          server: "lab",
        })
        expect(stopped.status).toBe("completed")
        expect(stopped.output).toEqual({ sessionID: remoteSessionID, interrupted: true })

        const waited = yield* call(registry, sessionID, "opencode_session_wait", {
          sessionID: remoteSessionID,
          server: "lab",
        })
        expect(waited.status).toBe("completed")
        expect(waited.output).toEqual({ sessionID: remoteSessionID, idle: true, outcome: "succeeded" })

        expect(calls.map((entry) => entry.op)).toEqual(["send", "stop", "wait"])
      }),
    ),
  )
})
