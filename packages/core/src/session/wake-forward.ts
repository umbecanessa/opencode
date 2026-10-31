export * as SessionWakeForward from "./wake-forward.js"

import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { KV } from "../kv.js"
import { SessionSchema } from "./schema.js"

/**
 * Wake coordination between servers that share one database. An execution
 * claim stamped by another boot is only routable when that boot still answers
 * at its advertised URL: `probe` consults its `/api/info` (any HTTP answer
 * means the process lives; a parseable foreign boot id means the URL was
 * reused by a different server and counts as dead). When the owner answers, a
 * wake is forwarded so its inbox drains where it is owned, and an interrupt
 * forwarded through `forwardInterrupt` stops the drain there.
 *
 * Credentials: each server boot registers the password it serves under
 * `cluster.server/<url>` in the shared KV store (see ServerProcess boot), and
 * cross-server calls attach it as Basic auth — the same scheme configured
 * peer servers use. Sharing the database is the trust domain: it already
 * holds every Session's contents for exactly these servers. An owner that
 * registered no credential is called unauthenticated; auth-rejected forwards
 * and probes degrade to the credential-less behavior (fence over it).
 */
export interface Interface {
  readonly probe: (url: string, bootID: string) => Effect.Effect<boolean>
  readonly forward: (url: string, sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Forwards a user interrupt to the owner's public endpoint; reports whether the call landed and what it answered. */
  readonly forwardInterrupt: (
    url: string,
    sessionID: SessionSchema.ID,
    resume?: boolean,
  ) => Effect.Effect<{ readonly delivered: boolean; readonly interrupted: boolean }>
}

/** KV key under which a boot registers its serving URL's wake/interrupt credential. */
export const serverKey = (url: string) => `cluster.server/${url}`

const Credential = Schema.Struct({ credential: Schema.optional(Schema.String) })

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionWakeForward") {}

const InfoBody = Schema.Struct({ id: Schema.optional(Schema.String) })
const isInfoBody = Schema.is(InfoBody)
const InterruptBody = Schema.Struct({
  interrupted: Schema.optional(Schema.Boolean),
  data: Schema.optional(Schema.Struct({ interrupted: Schema.optional(Schema.Boolean) })),
})
const PROBE_TIMEOUT = "3 seconds"

const base = (url: string) => url.replace(/\/+$/, "")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const kv = yield* KV.Service
    // The owner boot's registered password, if any, sent as Basic auth exactly
    // like the configured-peer client does. Absent → credential-less calls.
    const auth = (request: HttpClientRequest.HttpClientRequest, url: string) =>
      Effect.gen(function* () {
        const registered = yield* kv.get(serverKey(base(url)))
        const credential =
          registered === undefined
            ? undefined
            : Schema.decodeUnknownOption(Credential)(registered).pipe(
                Option.getOrElse<{ readonly credential?: string }>(() => ({})),
              ).credential
        return credential === undefined
          ? request
          : HttpClientRequest.setHeader(
              request,
              "authorization",
              `Basic ${Buffer.from(`opencode:${credential}`).toString("base64")}`,
            )
      })
    const call = (request: Effect.Effect<HttpClientRequest.HttpClientRequest>, url: string) =>
      request.pipe(
        Effect.flatMap((made) => auth(made, url)),
        Effect.flatMap((made) => http.execute(made)),
        Effect.timeoutOption(PROBE_TIMEOUT),
        Effect.catch(() => Effect.succeed(Option.none())),
      )
    return Service.of({
      probe: Effect.fn("SessionWakeForward.probe")(function* (url, bootID) {
        const result = yield* call(Effect.sync(() => HttpClientRequest.get(`${base(url)}/api/info`)), url)
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
        const result = yield* call(
          Effect.sync(
            () =>
              HttpClientRequest.post(
                `${base(url)}/api/experimental/session/${encodeURIComponent(sessionID)}/wake`,
              ),
          ),
          url,
        )
        return Option.isSome(result) && result.value.status < 300
      }),
      forwardInterrupt: Effect.fn("SessionWakeForward.forwardInterrupt")(function* (url, sessionID, resume) {
        const query = resume === undefined ? "" : `?resume=${resume}`
        const result = yield* call(
          Effect.sync(
            () =>
              HttpClientRequest.post(`${base(url)}/api/session/${encodeURIComponent(sessionID)}/interrupt${query}`),
          ),
          url,
        )
        if (Option.isNone(result) || result.value.status >= 300) return { delivered: false, interrupted: false }
        const text = yield* result.value.text.pipe(Effect.catch(() => Effect.succeed("")))
        const body = Schema.decodeUnknownOption(InterruptBody)(text).pipe(Option.orElse(() => Option.none()))
        const interrupted = Option.isSome(body) ? (body.value.interrupted ?? body.value.data?.interrupted) : undefined
        // Delivered but unreadable verdict: treat as not interrupted; the owner
        // still ran its routed interrupt, which is what the stop was for.
        return { delivered: true, interrupted: interrupted ?? false }
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [httpClient, KV.node],
})
