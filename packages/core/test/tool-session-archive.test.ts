import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Schedule } from "effect"
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
import { Global } from "@opencode/util/global"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const unused = () => Effect.die("unused by archive guard")
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
    text: unused,
    read: unused,
    names: Effect.succeed([]),
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
  name: "test/archive-tool-plugins",
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
    PeerServers.node.replace(peerStub),
    offlineModels,
    PluginSupervisor.node.replace(sessionToolPluginSupervisor),
  ]),
)

// The invoking agent's session-coordination policy: "deny" proves the silent path
// never asks, and proves the guarded path actually routes through the permission
// layer rather than deciding in the executor. "ask" reaches the interactive ask
// path: a session-scoped ask rule ordered after the broad allow, since rule
// evaluation keeps the last matching rule.
const withTools =
  (permissionEffect: "allow" | "deny" | "ask" | "persona") =>
  (
    run: (
      registry: Tool.Interface,
      sessionID: Session.ID,
      sessions: Session.Interface,
      location: Location.Ref,
      permission: Permission.Interface,
    ) => Effect.Effect<void>,
  ) =>
    () =>
      Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (d) => Effect.promise(() => d[Symbol.asyncDispose]()),
        )
      const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ location, title: "Coordinator" })
      const locations = yield* LocationServiceMap.Service
      yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(Effect.provide(locations.get(location)))
      yield* Agent.Service.use((agents) =>
        agents.transform((editor) => {
          editor.update(toolIdentity.agent, (agent) => {
            agent.mode = "primary"
            if (permissionEffect === "ask") {
              agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
              agent.permissions.push({ action: "session", resource: "*", effect: "ask" })
              agent.permissions.push({ action: "session_archive", resource: "*", effect: "ask" })
            } else if (permissionEffect === "persona") {
              // The scrum persona shape: a deny-all base, with the session family
              // allowed so spawn/send run silent. Archive must not inherit that
              // allow; the explicit ask rule is what keeps its proposal path alive.
              agent.permissions.push({ action: "*", resource: "*", effect: "deny" })
              agent.permissions.push({ action: "session", resource: "*", effect: "allow" })
              agent.permissions.push({ action: "session_archive", resource: "*", effect: "ask" })
            } else agent.permissions.push({ action: "*", resource: "*", effect: permissionEffect })
          })
        }),
      ).pipe(Effect.provide(locations.get(location)))
      const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(location)))
      const permission = yield* Permission.Service.pipe(Effect.provide(locations.get(location)))
      yield* run(registry, parent.id, sessions, location, permission)
    })

const call = (registry: Tool.Interface, sessionID: Session.ID, name: string, input: Record<string, unknown>) =>
  executeTool(registry, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call", id: `call-${name}-${Math.random()}`, name, input },
  })

// The archive tool's assert registers a pending ask before it waits for a reply,
// so the call runs in a fiber and the request itself is observed here; the test
// then rejects to land the call on its error channel.
const waitForAsk = (permission: Permission.Interface, sessionID: Session.ID, target: Session.ID) =>
  permission.forSession(sessionID).pipe(
    Effect.map((requests) => requests.find((request) => request.resources.includes(target))),
    Effect.repeat({ while: (found) => found === undefined, schedule: Schedule.spaced("10 millis") }),
    Effect.timeout("10 seconds"),
    Effect.catchTag("TimeoutError", () => Effect.die("archive permission ask never appeared")),
    Effect.flatMap((found) =>
      found === undefined ? Effect.die("archive permission ask vanished") : Effect.succeed(found),
    ),
  )

const spawnLane = Effect.fn("spawnLane")(function* (
  registry: Tool.Interface,
  parentID: Session.ID,
  promptText: string,
) {
  const settled = yield* call(registry, parentID, "opencode_session_spawn", {
    title: "throwaway lane",
    prompt: promptText,
    background: true,
  })
  expect(settled.status).toBe("completed")
  return (settled.metadata as { sessionID: Session.ID }).sessionID
})

describe("session_archive", () => {
  it.live(
    "archives a lane this session spawned without asking",
    withTools("allow")((registry, sessionID, sessions, location) =>
      Effect.gen(function* () {
        const lane = yield* spawnLane(registry, sessionID, "do the thing")
        // The spawn prompt is stamped as machine lineage, not a human turn. The stubbed
        // runner never delivers, so the marker rides the pending inbox item.
        const pending = yield* sessions.inbox(lane).pipe(Effect.orDie)
        const prompt = pending.find((item) => item.type === "user")
        expect(prompt?.type === "user" ? prompt.payload.metadata?.source : undefined).toBe("session_spawn")
        expect(prompt?.type === "user" ? prompt.payload.metadata?.parentSessionID : undefined).toBe(sessionID)

        const settled = yield* call(registry, sessionID, "opencode_session_archive", { sessionID: lane })
        expect(settled.status).toBe("completed")
        const archived = yield* sessions.get(lane).pipe(Effect.orDie)
        expect(archived.time.archived).toBeDefined()

        // Idempotent: a second call reports the already-archived state.
        const again = yield* call(registry, sessionID, "opencode_session_archive", { sessionID: lane })
        expect(again.status).toBe("completed")
      }),
    ),
  )

  it.live(
    "counts session_send follow-ups as machine turns, not human",
    withTools("allow")((registry, sessionID, sessions, location) =>
      Effect.gen(function* () {
        const lane = yield* spawnLane(registry, sessionID, "first")
        const sent = yield* call(registry, sessionID, "opencode_session_send", { sessionID: lane, prompt: "follow-up" })
        expect(sent.status).toBe("completed")
        const settled = yield* call(registry, sessionID, "opencode_session_archive", { sessionID: lane })
        expect(settled.status).toBe("completed")
        const pending = yield* sessions.inbox(lane).pipe(Effect.orDie)
        const sends = pending.filter(
          (item) => item.type === "user" && item.payload.metadata?.source === "session_send",
        )
        expect(sends).toHaveLength(1)
      }),
    ),
  )

  it.live(
    "asks before archiving a session it did not spawn",
    withTools("deny")((registry, sessionID, sessions, location) =>
      Effect.gen(function* () {
        const other = yield* sessions.create({ location, title: "Elsewhere" }).pipe(Effect.orDie)
        const settled = yield* call(registry, sessionID, "opencode_session_archive", { sessionID: other.id })
        expect(settled.status).toBe("error")
        expect(JSON.stringify(settled.error)).toContain("permission.rejected")
        const row = yield* sessions.get(other.id).pipe(Effect.orDie)
        expect(row.time.archived).toBeUndefined()
      }),
    ),
  )

  it.live(
    "asks before archiving a spawned lane that received human prompts",
    withTools("deny")((registry, sessionID, sessions, location) =>
      Effect.gen(function* () {
        const lane = yield* sessions.create({ location, title: "Lane" }).pipe(Effect.orDie)
        // The marker of a lane this session spawned, then a human writes into it.
        yield* sessions
          .prompt({
            sessionID: lane.id,
            text: "lane prompt",
            resume: false,
            metadata: { source: "session_spawn", parentSessionID: sessionID },
          })
          .pipe(Effect.orDie)
        yield* sessions.prompt({ sessionID: lane.id, text: "a human typed this", resume: false }).pipe(Effect.orDie)
        const settled = yield* call(registry, sessionID, "opencode_session_archive", { sessionID: lane.id })
        expect(settled.status).toBe("error")
        expect(JSON.stringify(settled.error)).toContain("permission.rejected")
        const row = yield* sessions.get(lane.id).pipe(Effect.orDie)
        expect(row.time.archived).toBeUndefined()
      }),
    ),
  )

  it.live(
    "still archives its own marker-only lane under a deny policy",
    withTools("deny")((registry, sessionID, sessions, location) =>
      Effect.gen(function* () {
        const lane = yield* sessions.create({ location, title: "Lane2" }).pipe(Effect.orDie)
        yield* sessions
          .prompt({
            sessionID: lane.id,
            text: "lane prompt",
            resume: false,
            metadata: { source: "session_spawn", parentSessionID: sessionID },
          })
          .pipe(Effect.orDie)
        yield* sessions
          .synthetic({ sessionID: lane.id, text: "wake", delivery: "queue" })
          .pipe(Effect.orDie)
        const settled = yield* call(registry, sessionID, "opencode_session_archive", { sessionID: lane.id })
        expect(settled.status).toBe("completed")
        const row = yield* sessions.get(lane.id).pipe(Effect.orDie)
        expect(row.time.archived).toBeDefined()
      }),
    ),
  )

  it.live(
    "the ask names the guard that tripped: no spawn marker",
    withTools("ask")((registry, sessionID, sessions, location, permission) =>
      Effect.gen(function* () {
        const other = yield* sessions.create({ location, title: "Elsewhere" }).pipe(Effect.orDie)
        const fiber = yield* Effect.forkChild(
          call(registry, sessionID, "opencode_session_archive", { sessionID: other.id }),
        )
        const request = yield* waitForAsk(permission, sessionID, other.id)
        expect(request.message).toContain("no session_spawn marker")
        yield* permission.reply({ requestID: request.id, reply: "reject" }).pipe(Effect.orDie)
        // The decline travels as a deliberate defect (resurfaces typed only at
        // SessionModelRequest.executeTool, outside this harness), so the fiber's
        // exit cause carries it rather than a settled tool result.
        const exit = yield* Fiber.join(fiber).pipe(Effect.exit)
        const cause = exit._tag === "Success" ? "success" : exit.cause
        expect(String(cause)).toContain("Permission.DeclinedError")
        const row = yield* sessions.get(other.id).pipe(Effect.orDie)
        expect(row.time.archived).toBeUndefined()
      }),
    ),
  )

  it.live(
    "the ask names the guard that tripped: unmarked human turns",
    withTools("ask")((registry, sessionID, sessions, location, permission) =>
      Effect.gen(function* () {
        const lane = yield* sessions.create({ location, title: "Lane3" }).pipe(Effect.orDie)
        yield* sessions
          .prompt({
            sessionID: lane.id,
            text: "lane prompt",
            resume: false,
            metadata: { source: "session_spawn", parentSessionID: sessionID },
          })
          .pipe(Effect.orDie)
        yield* sessions.prompt({ sessionID: lane.id, text: "a human typed this", resume: false }).pipe(Effect.orDie)
        const fiber = yield* Effect.forkChild(
          call(registry, sessionID, "opencode_session_archive", { sessionID: lane.id }),
        )
        const request = yield* waitForAsk(permission, sessionID, lane.id)
        expect(request.message).toContain("1 unmarked user entry")
        yield* permission.reply({ requestID: request.id, reply: "reject" }).pipe(Effect.orDie)
        const exit = yield* Fiber.join(fiber).pipe(Effect.exit)
        const cause = exit._tag === "Success" ? "success" : exit.cause
        expect(String(cause)).toContain("Permission.DeclinedError")
        const row = yield* sessions.get(lane.id).pipe(Effect.orDie)
        expect(row.time.archived).toBeUndefined()
      }),
    ),
  )

  // Keeper for the scrum-reported defect: a persona that allows the session
  // family (so spawn/send stay silent) must NOT auto-approve archive's ask.
  // Before the dedicated session_archive action, the session allow rule matched
  // the guard assert and guarded archives passed silently on such personas.
  it.live(
    "a session-family-allowing persona still gets asked to archive",
    withTools("persona")((registry, sessionID, sessions, location, permission) =>
      Effect.gen(function* () {
        const coordinator = yield* sessions.create({ location, title: "OtherCoordinator" }).pipe(Effect.orDie)
        const lane = yield* sessions.create({ location, title: "Lane4" }).pipe(Effect.orDie)
        // Machine-marked turns only, but the spawn marker names a DIFFERENT session.
        yield* sessions
          .prompt({
            sessionID: lane.id,
            text: "lane prompt",
            resume: false,
            metadata: { source: "session_spawn", parentSessionID: coordinator.id },
          })
          .pipe(Effect.orDie)
        const fiber = yield* Effect.forkChild(
          call(registry, sessionID, "opencode_session_archive", { sessionID: lane.id }),
        )
        const request = yield* waitForAsk(permission, sessionID, lane.id)
        expect(request.action).toBe("session_archive")
        expect(request.message).toContain("no session_spawn marker")
        yield* permission.reply({ requestID: request.id, reply: "reject" }).pipe(Effect.orDie)
        const exit = yield* Fiber.join(fiber).pipe(Effect.exit)
        const cause = exit._tag === "Success" ? "success" : exit.cause
        expect(String(cause)).toContain("Permission.DeclinedError")
        const row = yield* sessions.get(lane.id).pipe(Effect.orDie)
        expect(row.time.archived).toBeUndefined()
      }),
    ),
  )
})
