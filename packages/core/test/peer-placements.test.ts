import { describe, expect } from "bun:test"
import { Effect, Option } from "effect"
import { KV } from "@opencode/core/kv"
import { PeerPlacements } from "@opencode/core/peer-placements"
import { SessionSchema } from "@opencode/core/session/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([PeerPlacements.node, KV.node])))

describe("PeerPlacements", () => {
  it.effect("records a placement and locates the session on its server", () =>
    Effect.gen(function* () {
      const placements = yield* PeerPlacements.Service
      const sessionID = SessionSchema.ID.create()
      expect(yield* placements.locate(sessionID)).toEqual(Option.none())

      yield* placements.record("lab", sessionID)
      expect(yield* placements.locate(sessionID)).toEqual(Option.some({ server: "lab" }))

      yield* placements.record("lab", sessionID)
      expect(yield* placements.locate(sessionID)).toEqual(Option.some({ server: "lab" }))
    }),
  )

  it.effect("keeps the first owner when another server tries to claim the session", () =>
    Effect.gen(function* () {
      const placements = yield* PeerPlacements.Service
      const sessionID = SessionSchema.ID.create()
      yield* placements.record("lab", sessionID)

      const error = yield* placements.record("other", sessionID).pipe(Effect.flip)
      expect(error).toBeInstanceOf(PeerPlacements.Conflict)
      expect(String(error)).toContain(`placed on "lab"`)
      expect(yield* placements.locate(sessionID)).toEqual(Option.some({ server: "lab" }))
    }),
  )

  it.effect("forgets placements so the session is simply not found afterward", () =>
    Effect.gen(function* () {
      const placements = yield* PeerPlacements.Service
      const sessionID = SessionSchema.ID.create()
      yield* placements.record("lab", sessionID)

      yield* placements.forget(sessionID)
      expect(yield* placements.locate(sessionID)).toEqual(Option.none())
      yield* placements.forget(sessionID)

      yield* placements.record("other", sessionID)
      expect(yield* placements.locate(sessionID)).toEqual(Option.some({ server: "other" }))
    }),
  )

  it.effect("treats a corrupted row as absent and lets a record overwrite it", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const placements = yield* PeerPlacements.Service
      const sessionID = SessionSchema.ID.create()
      yield* kv.set(`peer.placement/${sessionID}`, { nope: true })
      expect(yield* placements.locate(sessionID)).toEqual(Option.none())

      yield* placements.record("lab", sessionID)
      expect(yield* placements.locate(sessionID)).toEqual(Option.some({ server: "lab" }))
    }),
  )
})
