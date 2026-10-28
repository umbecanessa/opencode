export * as ServerPairing from "./pairing"

import { and, eq, gte, lt } from "drizzle-orm"
import { Context, Duration, Effect, Layer } from "effect"
import { Database } from "@opencode/core/database/database"
import { PairingCodeTable } from "@opencode/core/pairing/sql"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { randomBytes } from "node:crypto"

const TTL = Duration.minutes(5)

export interface Interface {
  readonly issue: () => Effect.Effect<{ readonly code: string; readonly expires_in: number }>
  readonly consume: (code: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ServerPairing") {}

// Codes live in the shared database rather than process memory so redemption finds codes minted by any process
// over the same data directory: a Tailscale serve proxy landing on another server instance, a service versus
// embedded-app split, or an app restart between minting and redeeming the link.
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const cutoff = () => Date.now() - Duration.toMillis(TTL)
    return Service.of({
      issue: Effect.fn("ServerPairing.issue")(function* () {
        const code = randomBytes(16).toString("base64url")
        yield* db.delete(PairingCodeTable).where(lt(PairingCodeTable.time_created, cutoff())).run().pipe(Effect.orDie)
        yield* db.insert(PairingCodeTable).values({ code }).run().pipe(Effect.orDie)
        return { code, expires_in: Duration.toSeconds(TTL) }
      }),
      // The conditional delete is the single-use guarantee: concurrent redeemers race, and only one sees a row.
      consume: Effect.fn("ServerPairing.consume")(function* (code) {
        const redeemed = yield* db
          .delete(PairingCodeTable)
          .where(and(eq(PairingCodeTable.code, code), gte(PairingCodeTable.time_created, cutoff())))
          .returning({ code: PairingCodeTable.code })
          .get()
          .pipe(Effect.orDie)
        return redeemed !== undefined
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
