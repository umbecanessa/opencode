export * as ServerIdentity from "./server-identity.js"

import { Context, Effect, Layer, Ref } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

/**
 * Identity of this server PROCESS for execution-claim attribution. The id is a
 * fresh boot identifier: it never needs to survive a restart, because a claim
 * left behind by a dead boot is discovered by the liveness probe, not by id
 * matching. `urls` are what this process advertises for wake forwarding; they
 * stay empty until the server process announces them (an embedded or tool-run
 * host simply has no address others can wake it on).
 */
export interface Interface {
  readonly id: string
  readonly announce: (urls: readonly string[]) => Effect.Effect<void>
  /** URLs the last `announce` published; empty before any listener bound. */
  readonly urls: Effect.Effect<readonly string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ServerIdentity") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const urls = yield* Ref.make<readonly string[]>([])
    return Service.of({
      id: crypto.randomUUID(),
      announce: (next) => Ref.set(urls, [...next]),
      urls: Ref.get(urls),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [],
})
