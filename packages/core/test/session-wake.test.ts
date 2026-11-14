import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { promptLocationNode } from "./fixture/prompt-location"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const wakes: Session.ID[] = []
const recording = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set<Session.ID>()),
    activeCluster: Effect.succeed(new Set<Session.ID>()),
    isActive: () => Effect.succeed(false),
    resume: () => Effect.void,
    wake: (sessionID) => Effect.sync(() => void wakes.push(sessionID)),
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(recording),
    ],
  ),
)

const location = Location.Ref.make({ directory: AbsolutePath.make("/wake") })

describe("Session wake scheduling", () => {
  // The scrum coordinator's scans re-admit stable wake ids forever; every duplicate
  // used to schedule an advisory wake, booting empty drains (idle markers with no
  // delivery, model call, or message). Waking must follow the admission, not the call.
  it.live("a retried synthetic wakes while pending but not after delivery", () =>
    Effect.gen(function* () {
      wakes.length = 0
      const session = yield* Session.Service
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ id: Session.ID.create(), location })
      const itemID = SessionMessage.ID.create()
      const wake = () =>
        session.synthetic({ sessionID: created.id, id: itemID, text: "scrum wake: nudge", delivery: "queue" })

      yield* wake()
      expect(wakes).toEqual([created.id])

      // A retry whose row is still waiting must still wake: it is the recovery path
      // for a lost advisory wake against an idle session.
      yield* wake()
      expect(wakes).toEqual([created.id, created.id])

      yield* SessionInbox.promote(database.db, bus, created.id, "input")

      // The delivered retry admits nothing new (first admission already won), so it
      // must not schedule another run.
      yield* wake()
      expect(wakes).toHaveLength(2)
      expect((yield* session.messages({ sessionID: created.id })).filter((m) => m.type === "synthetic")).toHaveLength(1)
    }),
  )

  it.live("a retried prompt wakes while pending but not after delivery", () =>
    Effect.gen(function* () {
      wakes.length = 0
      const session = yield* Session.Service
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ id: Session.ID.create(), location })
      const itemID = SessionMessage.ID.create()
      const prompt = () => session.prompt({ sessionID: created.id, id: itemID, text: "hello", delivery: "queue" })

      yield* prompt()
      expect(wakes).toEqual([created.id])

      yield* SessionInbox.promote(database.db, bus, created.id, "input")

      yield* prompt()
      expect(wakes).toHaveLength(1)
    }),
  )
})
