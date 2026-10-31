export * as PeerPlacements from "./peer-placements.js"

import { Context, Effect, Layer, Option, Schema } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { KV } from "./kv.js"
import { SessionSchema } from "./session/schema.js"

/**
 * Durable ownership record for dispatched sessions: a session ID created on a
 * peer OpenCode server stays attributed to that server across restarts, so
 * later sends, stops, and waits route by session ID alone. The first dispatch
 * of a session ID owns it; re-recording the same server refreshes the row,
 * and a different server is a conflict rather than a silent rebind.
 */
export interface Entry {
  readonly server: string
}

export class Conflict extends Schema.TaggedError<Conflict>()("PeerPlacements.Conflict", {
  sessionID: SessionSchema.ID,
  server: Schema.String,
  owner: Schema.String,
}) {
  override get message() {
    return `session ${this.sessionID} is placed on "${this.owner}", not "${this.server}"`
  }
}

export interface Interface {
  readonly record: (server: string, sessionID: SessionSchema.ID) => Effect.Effect<void, Conflict>
  readonly locate: (sessionID: SessionSchema.ID) => Effect.Effect<Option.Option<Entry>>
  readonly forget: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PeerPlacements") {}

const prefix = "peer.placement/"
const Placement = Schema.Struct({ server: Schema.String })
const isPlacement = Schema.is(Placement)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service

    // KV values are durable JSON written by this service only; a row that no
    // longer matches the shape is treated as absent instead of failing the lookup.
    const read = (sessionID: SessionSchema.ID) =>
      kv.get(`${prefix}${sessionID}`).pipe(
        Effect.map((value): Option.Option<Entry> =>
          value !== undefined && isPlacement(value) ? Option.some({ server: value.server }) : Option.none(),
        ),
      )

    return Service.of({
      record: Effect.fn("PeerPlacements.record")(function* (server, sessionID) {
        const existing = yield* read(sessionID)
        if (Option.isSome(existing) && existing.value.server !== server)
          return yield* new Conflict({ sessionID, server, owner: existing.value.server })
        yield* kv.set(`${prefix}${sessionID}`, { server })
      }),
      locate: read,
      forget: (sessionID) => kv.remove(`${prefix}${sessionID}`),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node] })
