import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Document, Info } from "@opencode/schema/config"
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
import { SessionExecution } from "@opencode/core/session/execution"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { SessionTools } from "@opencode/core/tool/plugin/session"
import { Tool } from "@opencode/core/tool"
import { Workspace } from "@opencode/core/workspace"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import { makeSshDriver } from "@opencode/core/workspace/driver-ssh"
import { make } from "effect/process/ChildProcessSpawner"
import { Global } from "@opencode/util/global"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const unused = () => Effect.die("unused by workspace placement")
const peerStub = Layer.succeed(
  PeerServers.Service,
  PeerServers.Service.of({
    list: unused,
    spawn: unused,
    dispatch: unused,
    watch: unused,
    send: unused,
    stop: unused,
    wait: unused,
    outcome: unused,
    names: Effect.succeed([]),
  }),
)

const configNode = makeLocationNode({
  name: "test/workspace-config",
  layer: Config.testLayer([
    new Document({
      type: "document",
      info: new Info({
        workspaces: {
          lab: { type: "ssh", host: "example.invalid", user: "bob", directory: "/srv/remote/app" },
        },
      }),
    }),
  ]),
  deps: [],
})

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
  name: "test/workspace-tool-plugins",
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
    Config.node.replace(configNode),
    PeerServers.node.replace(peerStub),
    // The ssh placement provider used by Workspace.create in the tool path.
    WorkspaceDriver.node.replace(
      Layer.succeed(
        WorkspaceDriver.RegistryService,
        WorkspaceDriver.registry({ ssh: makeSshDriver(make(() => Effect.interrupt)) }),
      ),
    ),
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
  (run: (registry: Tool.Interface, sessionID: Session.ID, sessions: Session.Interface) => Effect.Effect<void>) =>
  () =>
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
          yield* run(registry, parent.id, sessions)
        }),
      ),
    )

const call = (registry: Tool.Interface, sessionID: Session.ID, name: string, input: Record<string, unknown>) =>
  executeTool(registry, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call", id: `call-${name}`, name, input },
  })

describe("SessionTools workspace placement", () => {
  it.live(
    "places a spawned session on the configured ssh workspace",
    withTools((registry, sessionID, sessions) =>
      Effect.gen(function* () {
        const settled = yield* call(registry, sessionID, "opencode_session_spawn", {
          title: "remote task",
          prompt: "work on the remote host",
          workspace: "lab",
          background: true,
        })
        expect(settled.status).toBe("completed")
        expect(settled.metadata?.status).toBe("running")
        const childID = (settled.metadata as { sessionID: Session.ID }).sessionID
        const child = yield* sessions.get(childID).pipe(Effect.orDie)
        expect(child.location.workspaceID).toBe(Workspace.ID.ascending("wrk_cfg_lab"))
        expect(child.location.directory).toBe(AbsolutePath.make("/srv/remote/app"))
      }),
    ),
  )

  it.live(
    "reuses the same placement id for repeat spawns",
    withTools((registry, sessionID, sessions) =>
      Effect.gen(function* () {
        const first = yield* call(registry, sessionID, "opencode_session_spawn", {
          title: "one",
          prompt: "first",
          workspace: "lab",
          background: true,
        })
        const second = yield* call(registry, sessionID, "opencode_session_spawn", {
          title: "two",
          prompt: "second",
          workspace: "lab",
          background: true,
        })
        const locations = yield* Effect.forEach(
          [first, second],
          (settled) =>
            sessions.get((settled.metadata as { sessionID: Session.ID }).sessionID).pipe(Effect.orDie),
        )
        expect(locations.map((session) => session.location.workspaceID)).toEqual([
          Workspace.ID.ascending("wrk_cfg_lab"),
          Workspace.ID.ascending("wrk_cfg_lab"),
        ])
      }),
    ),
  )

  it.live(
    "surfaces the configured-workspace list for an unknown workspace",
    withTools((registry, sessionID) =>
      Effect.gen(function* () {
        const settled = yield* call(registry, sessionID, "opencode_session_spawn", {
          title: "nowhere",
          prompt: "hello",
          workspace: "nope",
        })
        expect(settled.status).toBe("error")
        expect(JSON.stringify(settled.error)).toContain("Configured workspaces: lab")
      }),
    ),
  )

  it.live(
    "rejects workspace combined with directory",
    withTools((registry, sessionID) =>
      Effect.gen(function* () {
        const settled = yield* call(registry, sessionID, "opencode_session_spawn", {
          title: "conflict",
          prompt: "hello",
          workspace: "lab",
          directory: "/some/local/dir",
        })
        expect(settled.status).toBe("error")
        expect(JSON.stringify(settled.error)).toContain("directory does not apply with workspace")
      }),
    ),
  )

  it.live(
    "rejects workspace combined with server",
    withTools((registry, sessionID) =>
      Effect.gen(function* () {
        const settled = yield* call(registry, sessionID, "opencode_session_spawn", {
          title: "conflict",
          prompt: "hello",
          workspace: "lab",
          server: "peer",
        })
        expect(settled.status).toBe("error")
        expect(JSON.stringify(settled.error)).toContain("workspace does not apply with server")
      }),
    ),
  )
})
