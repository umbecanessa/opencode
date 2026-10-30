export * as PeerServers from "./peer-servers.js"

import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { Config } from "./config.js"
import { Model } from "./model.js"
import { SessionSchema } from "./session/schema.js"

export type Outcome = "succeeded" | "failed" | "interrupted"

/** A remote session projected into the same row shape local session listings produce. */
export interface Entry {
  readonly id: SessionSchema.ID
  readonly title?: string
  readonly agent?: string
  readonly model?: string
  readonly directory: string
  readonly active: boolean
  readonly outcome?: Outcome
  readonly updated: number
  readonly parentID?: SessionSchema.ID
}

export class Failure extends Schema.TaggedError<Failure>()("PeerServers.Failure", {
  server: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return `${this.server}: ${this.detail}`
  }
}

export interface Interface {
  readonly list: (
    server: string,
    input: { readonly search?: string; readonly limit?: number; readonly temporary?: boolean },
  ) => Effect.Effect<Entry[], Failure>
  readonly spawn: (
    server: string,
    input: {
      readonly title: string
      readonly prompt: string
      readonly agent?: string
      readonly model?: typeof Model.Ref.Type
      readonly temporary?: boolean
    },
  ) => Effect.Effect<
    { readonly sessionID: SessionSchema.ID; readonly text?: string; readonly outcome?: Outcome },
    Failure
  >
  readonly send: (
    server: string,
    input: { readonly sessionID: SessionSchema.ID; readonly prompt: string; readonly delivery?: "steer" | "queue" },
  ) => Effect.Effect<void, Failure>
  readonly stop: (
    server: string,
    input: { readonly sessionID: SessionSchema.ID; readonly resume?: boolean },
  ) => Effect.Effect<boolean, Failure>
  readonly wait: (server: string, sessionID: SessionSchema.ID) => Effect.Effect<void, Failure>
  readonly outcome: (server: string, sessionID: SessionSchema.ID) => Effect.Effect<Outcome | undefined, Failure>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PeerServers") {}

/** Wire subset of the remote `Session.Info` payload: only the fields listings and waits need. */
const SessionBody = Schema.Struct({
  id: SessionSchema.ID,
  title: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(
    Schema.Struct({ providerID: Schema.String, id: Schema.String, variant: Schema.optionalKey(Schema.String) }),
  ),
  outcome: Schema.optionalKey(Schema.Literals(["succeeded", "failed", "interrupted"])),
  parentID: Schema.optionalKey(SessionSchema.ID),
  location: Schema.Struct({ directory: Schema.String }),
  time: Schema.Struct({ updated: Schema.Finite }),
})

const CreateBody = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Model.Ref),
  temporary: Schema.optionalKey(Schema.Boolean),
})

const PromptBody = Schema.Struct({
  text: Schema.String,
  delivery: Schema.optionalKey(Schema.Literals(["steer", "queue"])),
})

const SessionResponse = Schema.Struct({ data: SessionBody })
const SessionsResponse = Schema.Struct({ data: Schema.Array(SessionBody) })
const ActiveResponse = Schema.Struct({
  data: Schema.Record(Schema.String, Schema.Struct({ type: Schema.Literal("running") })),
})
const InterruptResponse = Schema.Struct({ interrupted: Schema.Boolean })
const InboxResponse = Schema.Struct({ data: Schema.Array(Schema.Unknown) })
const ContextResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      content: Schema.optionalKey(
        Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })),
      ),
    }),
  ),
})

/** Last assistant text block of the remote context window, newest message first. */
function lastText(messages: readonly { type: string; content?: readonly { type: string; text?: string }[] }[]) {
  for (const message of messages.slice().reverse()) {
    if (message.type !== "assistant") continue
    const text = message.content?.slice().reverse().find((part) => part.type === "text")?.text
    if (text) return text
  }
  return undefined
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const http = yield* HttpClient.HttpClient

    const target = Effect.fn("PeerServers.target")(function* (server: string) {
      const servers = Config.latest(yield* config.entries(), "servers")
      const info = servers?.[server]
      if (info === undefined)
        return yield* new Failure({
          server,
          detail: `is not configured. Configured servers: ${Object.keys(servers ?? {}).join(", ") || "none"}`,
        })
      return { base: info.url.replace(/\/+$/, ""), credential: info.credential }
    })

    const call = Effect.fn("PeerServers.call")(function* (
      server: string,
      make: (base: string) => Effect.Effect<HttpClientRequest.HttpClientRequest, Failure>,
    ) {
      const at = yield* target(server)
      const request = (yield* make(at.base)).pipe(
        HttpClientRequest.setHeader(
          "authorization",
          `Basic ${Buffer.from(`opencode:${at.credential ?? ""}`).toString("base64")}`,
        ),
      )
      const response = yield* http
        .execute(request)
        .pipe(Effect.mapError(() => new Failure({ server, detail: "the server could not be reached" })))
      if (response.status === 401 || response.status === 403)
        return yield* new Failure({
          server,
          detail: `authentication failed (HTTP ${response.status}): set the server's credential in the \`servers\` config`,
        })
      if (response.status === 404) return yield* new Failure({ server, detail: "not found (HTTP 404)" })
      if (response.status >= 400) {
        const body = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")))
        return yield* new Failure({
          server,
          detail: `request failed (HTTP ${response.status})${body.trim() ? `: ${body.trim().slice(0, 300)}` : ""}`,
        })
      }
      return response
    })

    const json = <S extends Schema.Top>(server: string, schema: S) => (response: HttpClientResponse.HttpClientResponse) =>
      HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.mapError(() => new Failure({ server, detail: "the server returned an unexpected response" })),
      )

    const get = (path: string) => (base: string) => Effect.succeed(HttpClientRequest.get(`${base}${path}`))
    const post = (path: string) => (base: string) => Effect.succeed(HttpClientRequest.post(`${base}${path}`))
    const postJson = <S extends Schema.Top>(path: string, schema: S, value: S["Type"]) => (base: string) =>
      post(path)(base).pipe(
        Effect.flatMap(HttpClientRequest.schemaBodyJson(schema)(value)),
        Effect.mapError(
          () =>
            new Failure({
              server: "",
              detail: "internal: failed to encode the request body",
            }),
        ),
      )

    const waitRemote = (server: string, sessionID: SessionSchema.ID) =>
      call(server, post(`/api/experimental/session/${sessionID}/wait`)).pipe(Effect.asVoid)

    const interruptRemote = (server: string, sessionID: SessionSchema.ID, resume?: boolean) =>
      call(server, post(`/api/session/${sessionID}/interrupt${resume === undefined ? "" : `?resume=${resume}`}`)).pipe(
        Effect.flatMap(json(server, InterruptResponse)),
        Effect.map((body) => body.interrupted),
      )

    const outcomeOf = (server: string, sessionID: SessionSchema.ID) =>
      call(server, get(`/api/session/${sessionID}`)).pipe(
        Effect.flatMap(json(server, SessionResponse)),
        Effect.map((response) => response.data.outcome),
      )

    const running = (server: string, sessionID: SessionSchema.ID) =>
      call(server, get("/api/session/active")).pipe(
        Effect.flatMap(json(server, ActiveResponse)),
        Effect.map((body) => body.data[sessionID] !== undefined),
      )

    const pending = (server: string, sessionID: SessionSchema.ID) =>
      call(server, get(`/api/session/${sessionID}/inbox`)).pipe(
        Effect.flatMap(json(server, InboxResponse)),
        Effect.map((body) => body.data.length > 0),
      )

    /**
     * Remote `session.wait` resolves instantly when nothing is draining, which right after a
     * prompt can mean the advisory wake has not started execution yet. Re-check activity and
     * the undelivered inbox after every wait and keep waiting while either shows work.
     */
    const idleAfterPrompt = (server: string, sessionID: SessionSchema.ID): Effect.Effect<void, Failure> =>
      Effect.suspend(
        () =>
          Effect.gen(function* () {
            yield* waitRemote(server, sessionID)
            const [busy, queued] = yield* Effect.all([running(server, sessionID), pending(server, sessionID)], {
              concurrency: 2,
            })
            if (busy || queued) return yield* idleAfterPrompt(server, sessionID)
          }),
      )

    const entry = (session: typeof SessionBody.Type, active: boolean): Entry => ({
      id: session.id,
      ...(session.title === undefined ? {} : { title: session.title }),
      ...(session.agent === undefined ? {} : { agent: session.agent }),
      ...(session.model === undefined
        ? {}
        : {
            model: `${session.model.providerID}/${session.model.id}${
              session.model.variant === undefined ? "" : `#${session.model.variant}`
            }`,
          }),
      directory: session.location.directory,
      active,
      ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
      updated: session.time.updated,
      ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
    })

    return Service.of({
      list: Effect.fn("PeerServers.list")(function* (server, input) {
        const query = new URLSearchParams({ order: "desc", limit: String(input.limit ?? 20) })
        if (input.search !== undefined) query.set("search", input.search)
        if (input.temporary !== undefined) query.set("temporary", String(input.temporary))
        const [page, active] = yield* Effect.all(
          [
            call(server, get(`/api/session?${query.toString()}`)).pipe(Effect.flatMap(json(server, SessionsResponse))),
            call(server, get("/api/session/active")).pipe(Effect.flatMap(json(server, ActiveResponse))),
          ],
          { concurrency: 2 },
        )
        return page.data.map((session) => entry(session, active.data[session.id] !== undefined))
      }),

      spawn: Effect.fn("PeerServers.spawn")(function* (server, input) {
        const created = yield* call(
          server,
          postJson("/api/session", CreateBody, {
            title: input.title,
            ...(input.agent === undefined ? {} : { agent: input.agent }),
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.temporary === undefined ? {} : { temporary: input.temporary }),
          }),
        ).pipe(Effect.flatMap(json(server, SessionResponse)))
        const sessionID = created.data.id
        yield* call(server, postJson(`/api/session/${sessionID}/prompt`, PromptBody, { text: input.prompt })).pipe(
          Effect.asVoid,
        )
        // Blocking interruption stops the remote run: the caller gave up on the whole task.
        yield* idleAfterPrompt(server, sessionID).pipe(
          Effect.onInterrupt(() => interruptRemote(server, sessionID).pipe(Effect.ignore)),
        )
        const [context, outcome] = yield* Effect.all(
          [
            call(server, get(`/api/session/${sessionID}/context`)).pipe(Effect.flatMap(json(server, ContextResponse))),
            outcomeOf(server, sessionID),
          ],
          { concurrency: 2 },
        )
        return { sessionID, text: lastText(context.data), outcome }
      }),

      send: Effect.fn("PeerServers.send")(function* (server, input) {
        yield* call(
          server,
          postJson(`/api/session/${input.sessionID}/prompt`, PromptBody, {
            text: input.prompt,
            ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
          }),
        ).pipe(Effect.asVoid)
      }),

      stop: Effect.fn("PeerServers.stop")((server, input) => interruptRemote(server, input.sessionID, input.resume)),

      wait: Effect.fn("PeerServers.wait")((server, sessionID) => waitRemote(server, sessionID)),

      outcome: outcomeOf,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, httpClient],
})
