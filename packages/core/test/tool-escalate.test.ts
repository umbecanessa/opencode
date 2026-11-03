import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Job } from "@opencode/core/job"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { PeerServers } from "@opencode/core/peer-servers"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { EscalateTool } from "@opencode/core/tool/plugin/escalate"
import { Tool } from "@opencode/core/tool"
import { Global } from "@opencode/util/global"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "./lib/tool"

// Idle without running anything: escalate only admits durable inbox work, and
// the wake it asks for is what a real runner would turn into delivery.
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

const escalatePluginSupervisor = makeLocationNode({
  name: "test/escalate-tool-plugins",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* registerToolPlugin(EscalateTool.Plugin, {}, (name, callback) => hooks.register("tool", name, callback))
    }),
  ),
  deps: [Agent.node, Config.node, Model.node, PeerServers.node, Permission.node, Session.node, Job.node, Tool.node, PluginHooks.node],
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
    offlineModels,
    PluginSupervisor.node.replace(escalatePluginSupervisor),
  ]),
)

const withTools =
  <R>(run: (registry: Tool.Interface, parent: Session.ID, child: Session.ID) => Effect.Effect<void, never, R>) =>
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
          const child = yield* sessions.create({ parentID: parent.id, title: "Investigate the flake" })
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
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(location)))
          yield* run(registry, parent.id, child.id)
        }),
      ),
    )

const call = (registry: Tool.Interface, sessionID: Session.ID, input: Record<string, unknown>, id = "call-escalate") =>
  executeTool(registry, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call", id, name: "escalate", input },
  })

describe("escalate", () => {
  it.live(
    "delivers a child message into the parent inbox attributed to the child",
    withTools((registry, parent, child) =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
          Stream.filter((event) => event.data.sessionID === parent && event.data.item.type === "synthetic"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        )

        const settled = yield* call(registry, child, {
          message: "Two fixtures disagree about the clock; which one is authoritative?",
        })
        expect(settled.status).toBe("completed")
        expect(settled.output).toEqual({ parentID: parent, delivered: true })
        expect(settled.content).toEqual([
          { type: "text", text: expect.stringContaining(`parent session ${parent}`) },
        ])

        const admission = Array.from(yield* Fiber.join(admitted))[0]
        expect(admission?.data.item.type).toBe("synthetic")
        if (admission?.data.item.type !== "synthetic") return yield* Effect.die("Expected synthetic inbox item")
        expect(admission.data.item.payload.text).toContain(`<escalation sessionID="${child}"`)
        expect(admission.data.item.payload.text).toContain("which one is authoritative?")
        expect(admission.data.item.payload).toMatchObject({
          description: "Investigate the flake",
          metadata: { source: "escalate", childID: child },
        })

        const sessions = yield* Session.Service
        const database = yield* Database.Service
        yield* SessionInbox.promote(database.db, bus, parent, "steer")
        const synthetic = (yield* sessions.context(parent).pipe(Effect.orDie)).filter(
          (message) => message.type === "synthetic",
        )
        expect(synthetic).toHaveLength(1)
        expect(synthetic[0]?.text).toContain(`<escalation sessionID="${child}"`)
      }),
    ),
  )

  it.live(
    "queues behind the parent's work when delivery is queue",
    withTools((registry, parent, child) =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
          Stream.filter((event) => event.data.sessionID === parent && event.data.item.type === "synthetic"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        )
        const settled = yield* call(registry, child, { message: "found the cause", delivery: "queue" })
        expect(settled.status).toBe("completed")
        const admission = Array.from(yield* Fiber.join(admitted))[0]
        expect(admission?.data.item.type).toBe("synthetic")
        if (admission?.data.item.type === "synthetic") expect(admission.data.item.delivery).toBe("queue")
      }),
    ),
  )

  it.live(
    "fails for a session nobody spawned",
    withTools((registry, parent) =>
      Effect.gen(function* () {
        const settled = yield* call(registry, parent, { message: "no parent here" })
        expect(settled.status).toBe("error")
        expect(settled.error?.message).toContain("was not spawned by another session")
        expect(settled.error?.message).toContain("session_send")
      }),
    ),
  )

  it.live(
    "drops out of the tool list when the escalate permission is denied",
    withTools((registry) =>
      Effect.gen(function* () {
        expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toContain("escalate")
        const denied = yield* toolDefinitions(registry, [{ action: "escalate", resource: "*", effect: "deny" }])
        expect(denied.map((tool) => tool.name)).not.toContain("escalate")
      }),
    ),
  )
})
