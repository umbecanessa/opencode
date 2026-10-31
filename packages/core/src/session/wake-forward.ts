export * as SessionWakeForward from "./wake-forward.js"

import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { SessionSchema } from "./schema.js"

/**
 * Wake coordination between servers that share one database. An execution
 * claim stamped by another boot is only routable when that boot still answers
 * at its advertised URL: `probe` consults its unauthenticated `/api/info`
 * (any HTTP answer means the process lives; a parseable foreign boot id means
 * the URL was reused by a different server and counts as dead). When the
 * owner answers, a wake is forwarded so its inbox drains where it is owned.
 * Credential-less forwarding means an auth-gated owner cannot be woken over
 * the network; the caller then takes over under the fence rather than losing
 * the prompt.
 */
export interface Interface {
  readonly probe: (url: string, bootID: string) => Effect.Effect<boolean>
  readonly forward: (url: string, sessionID: SessionSchema.ID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionWakeForward") {}

const InfoBody = Schema.Struct({ id: Schema.optional(Schema.String) })
const isInfoBody = Schema.is(InfoBody)
const PROBE_TIMEOUT = "3 seconds"

const base = (url: string) => url.replace(/\/+$/, "")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    return Service.of({
      probe: Effect.fn("SessionWakeForward.probe")(function* (url, bootID) {
        const result = yield* http
          .execute(HttpClientRequest.get(`${base(url)}/api/info`))
          .pipe(Effect.timeoutOption(PROBE_TIMEOUT), Effect.catch(() => Effect.succeed(Option.none())))
        if (Option.isNone(result)) return false
        const text = yield* result.value.text.pipe(Effect.catch(() => Effect.succeed("")))
        const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(text).pipe(
          Option.getOrElse(() => ({})),
        )
        // A body that parses with a foreign id is a reused URL, not the owner.
        // Anything else — a versioned body without ids, an auth rejection —
        // still proves a live server answering on that address.
        if (isInfoBody(parsed) && parsed.id !== undefined) return parsed.id === bootID
        return true
      }),
      forward: Effect.fn("SessionWakeForward.forward")(function* (url, sessionID) {
        const result = yield* http
          .execute(
            HttpClientRequest.post(
              `${base(url)}/api/experimental/session/${encodeURIComponent(sessionID)}/wake`,
            ),
          )
          .pipe(Effect.timeoutOption(PROBE_TIMEOUT), Effect.catch(() => Effect.succeed(Option.none())))
        return Option.isSome(result) && result.value.status < 300
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [httpClient],
})
