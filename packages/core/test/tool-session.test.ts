import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { LanguageModel } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { Money } from "@opencode/schema/money"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { FileAccess } from "@opencode/core/file-access"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionStore } from "@opencode/core/session/store"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Permission } from "@opencode/core/permission"
import { PeerServers } from "@opencode/core/peer-servers"
import { SessionTools } from "@opencode/core/tool/plugin/session"
import { Tool } from "@opencode/core/tool"
import { Workspace } from "@opencode/core/workspace"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const peerText = "peer final response"
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const outputSessionID = (value: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ sessionID: Session.ID }))(value).sessionID

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const completed = new Set<Session.ID>()
      const complete = Effect.fn("PeerToolTest.complete")(function* (sessionID: Session.ID) {
        if (completed.has(sessionID)) return
        completed.add(sessionID)
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: Agent.ID.make("build"),
          model: Model.Ref.make({ id: Model.ID.make("peer"), providerID: Provider.ID.make("test") }),
          started: 0,
        })
        yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
        yield* bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text: peerText })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens,
        })
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: complete,
        wake: () => Effect.void,
        interrupt: () => Effect.succeed(false),
        awaitIdle: (sessionID) => complete(sessionID).pipe(Effect.exit, Effect.asVoid),
      })
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

const sessionToolPluginSupervisor = makeLocationNode({
  name: "test/session-tool-plugins",
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
const replacements = [
  SessionExecution.node.replace(executionNode),
  Global.node.replace(tempGlobalLayer),
  offlineModels,
] satisfies LayerNode.Replacements
const it = testEffect(
  AppNodeBuilder.build(nodes, [...replacements, PluginSupervisor.node.replace(sessionToolPluginSupervisor)]),
)
const completionIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([nodes, SessionRestart.node, KV.node]), [
    Global.node.replace(tempGlobalLayer),
    offlineModels,
    PluginSupervisor.node.replace(sessionToolPluginSupervisor),
    LayerNodePlatform.llmClient.replace(TestLLM.testLayer({ fallback: TestLLM.text(peerText, "completion") })),
    SessionRunnerModel.node.replace(
      Layer.succeed(SessionRunnerModel.Service, {
        resolve: () =>
          Effect.succeed(
            SessionRunnerModel.resolved(
              LanguageModel.make({ id: "peer", provider: "test", route: OpenAIChat.route }),
              {
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                cost: [],
                limit: { context: 200_000, output: 32_000 },
              },
            ),
          ),
      }),
    ),
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

describe("SessionTools", () => {
  it.live("spawns a level-zero session and returns its final text", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, title: "Orchestrator" })
          yield* withSessionTools(location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(location)))

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-session-spawn",
              name: "opencode_session_spawn",
              input: { title: "standalone work", prompt: "do the thing" },
            },
          })
          expect(settled.status).toBe("completed")
          const childID = outputSessionID(settled.metadata)
          expect(settled.metadata).toEqual({ sessionID: childID, status: "completed" })
          expect(settled.content).toEqual([
            { type: "text", text: expect.stringContaining(`<peer sessionID="${childID}" state="completed">`) },
          ])
          expect(settled.content).toEqual([{ type: "text", text: expect.stringContaining(peerText) }])

          // A spawned peer is a top-level session: no parent link back to the spawner.
          const child = yield* sessions.get(childID)
          expect(child.parentID).toBeUndefined()
          expect(child.title).toBe("standalone work")
        }),
      ),
    ),
  )

  it.live("spawns a temporary session hidden from listings with stricter permissions", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, title: "Orchestrator" })
          yield* withSessionTools(location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(location)))

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-session-spawn-temporary",
              name: "opencode_session_spawn",
              input: { title: "spot task", prompt: "do the thing", temporary: true },
            },
          })
          expect(settled.status).toBe("completed")
          const childID = outputSessionID(settled.metadata)
          const child = yield* sessions.get(childID)
          expect(child.temporary).toBe(true)
          expect(child.permissions).toContainEqual({ action: "session", resource: "*", effect: "deny" })
          expect(child.permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" })
          expect(child.permissions).toContainEqual({ action: "edit", resource: "*", effect: "deny" })

          // Disposable sessions are invisible to ordinary listings and the only
          // content of an explicit temporary listing.
          const ordinary = yield* sessions.list()
          expect(ordinary.data.map((session) => session.id)).not.toContain(childID)
          const disposables = yield* sessions.list({ temporary: true })
          expect(disposables.data.map((session) => session.id)).toEqual([childID])
        }),
      ),
    ),
  )

  it.live("reap deletes expired temporary sessions and leaves regular sessions alone", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const keeper = yield* sessions.create({ location, title: "Keeper" })
          const disposable = yield* sessions.create({ location, title: "Disposable", temporary: true })

          yield* sessions.reapTemporary

          expect(yield* sessions.get(keeper.id)).toBeDefined()
          const gone = yield* sessions.get(disposable.id).pipe(Effect.exit)
          expect(gone._tag).toBe("Failure")
          const disposables = yield* sessions.list({ temporary: true })
          expect(disposables.data).toHaveLength(0)
        }),
      ),
    ),
  )

  completionIt.live("notifies once with a peer-tagged message when a background spawn completes", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, title: "Notified parent" })
          yield* withSessionTools(location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(location)))
          const bus = yield* Bus.Service
          const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
            Stream.filter((event) => event.data.sessionID === parent.id && event.data.item.type === "synthetic"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          )

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-session-spawn-background",
              name: "opencode_session_spawn",
              input: { title: "background peer", prompt: "do the thing", background: true },
            },
          })
          expect(settled.status).toBe("completed")
          const childID = outputSessionID(settled.metadata)
          expect(settled.metadata).toEqual({ sessionID: childID, status: "running" })
          expect(settled.content).toEqual([{ type: "text", text: expect.stringContaining(`sessionID: ${childID}`) }])

          const admission = Array.from(yield* Fiber.join(admitted))[0]
          expect(admission?.data.item.type).toBe("synthetic")
          if (admission?.data.item.type !== "synthetic") return yield* Effect.die("Expected synthetic inbox item")
          expect(admission?.data.item.payload.text).toContain(`<peer sessionID="${childID}" state="completed"`)
          expect(admission?.data.item.payload).toMatchObject({
            description: "background peer",
            metadata: {
              source: "peer",
              childID,
              state: "completed",
            },
          })
          const database = yield* Database.Service
          yield* SessionInbox.promote(database.db, bus, parent.id, "steer")
          const synthetic = (yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")
          expect(synthetic).toHaveLength(1)
          expect(synthetic[0]?.text).toContain(`<peer sessionID="${childID}" state="completed"`)
          expect(synthetic[0]?.text).toContain(peerText)
        }),
      ),
    ),
  )
})
