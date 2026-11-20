import { describe, expect } from "bun:test"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { AnthropicPlugin } from "@opencode/core/plugin/provider/anthropic"
import { Duration, Effect, Fiber, Schedule } from "effect"
import { withEnv } from "../fixture/env"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const integrationID = Integration.ID.make("anthropic")
const methodID = Integration.MethodID.make("claude-subscription")
const bundledClientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const tokenBody = {
  access_token: "sk-ant-access",
  refresh_token: "sk-ant-refresh",
  expires_in: 3600,
  account: { uuid: "acct-1", email_address: "USER@Example.com" },
}
// Edge-gate throttling answers with retry-after "0"; tests exercise the retry path fast.
const throttled = {
  status: 429,
  body: { error: "rate_limit_error", message: "Rate limited. Please try again later." },
  headers: { "retry-after": "0" },
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> }

const setup = Effect.gen(function* () {
  const integrations = yield* Integration.Service
  const credentials = yield* Credential.Service
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin, "test")
  yield* AnthropicPlugin.effect(host)
  return { integrations, credentials }
})

// Loopback token endpoint; the last reply repeats forever so a runaway client cannot escape
// the recorded sequence, and per-request bodies let tests pin the POST shape.
const tokenServer = (replies: Reply[]) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const requests: Array<Record<string, unknown>> = []
      let index = 0
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          requests.push(
            request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {},
          )
          const reply = index < replies.length ? replies[index] : replies[replies.length - 1]
          index++
          return Response.json(reply.body ?? { error: "unexpected token request" }, {
            status: reply.status,
            headers: reply.headers,
          })
        },
      })
      return { server, requests, url: `http://127.0.0.1:${server.port}/v1/oauth/token` }
    }),
    ({ server }) => Effect.sync(() => server.stop()),
  )

// Keep global fetch offline except for loopback: the plugin's profile enrichment would
// otherwise phone api.anthropic.com with a fake token. The guard must delegate to the
// fetch captured here, not to refuseNetwork, whose own delegation reads globalThis.fetch
// at call time and would recurse forever once it is installed globally.
const offline = <A, E, R>(self: () => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.flatMap(
      Effect.acquireRelease(
        Effect.sync(() => {
          const previous = globalThis.fetch
          globalThis.fetch = Object.assign(
            (input: string | URL | Request, init?: RequestInit) =>
              loopback.has(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).hostname)
                ? previous(input, init)
                : Promise.reject(new Error(`test attempted network request: ${String(input)}`)),
            { preconnect: previous.preconnect },
          ) as typeof fetch
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            globalThis.fetch = previous
          }),
      ),
      () => self(),
    ),
  )

const loopback = new Set(["127.0.0.1", "localhost", "[::1]"])

const scenario = <A, E, R>(
  replies: Reply[],
  self: (server: { requests: Array<Record<string, unknown>>; url: string }) => Effect.Effect<A, E, R>,
) =>
  offline(() =>
    Effect.scoped(
      Effect.flatMap(tokenServer(replies), (server) =>
        withEnv({ ANTHROPIC_OAUTH_TOKEN_URL: server.url, ANTHROPIC_OAUTH_CLIENT_ID: undefined }, () =>
          self(server),
        ),
      ),
    ),
  )

const login = (integrations: Integration.Interface) =>
  Effect.gen(function* () {
    const attempt = yield* integrations.oauth.connect({ integrationID, methodID })
    const url = new URL(attempt.url)
    const callback = new URL(url.searchParams.get("redirect_uri") ?? "")
    callback.searchParams.set("state", url.searchParams.get("state") ?? "")
    callback.searchParams.set("code", "auth-code")
    return { attempt, url, callback }
  })

const settle = (
  integrations: Integration.Interface,
  attemptID: Integration.AttemptID,
  timeout: Duration.Input = "10 seconds",
) =>
  integrations.oauth
    .status({ integrationID, attemptID })
    .pipe(
      Effect.repeat({ until: (value) => value.status !== "pending", schedule: Schedule.spaced("20 millis") }),
      Effect.timeout(timeout),
    )

describe("AnthropicPlugin subscription OAuth", () => {
  it.live(
    "exchanges the callback code once with the official POST shape",
    () =>
      scenario([{ status: 200, body: tokenBody }], ({ requests }) =>
        Effect.gen(function* () {
          const { integrations, credentials } = yield* setup
          const { attempt, url: auth, callback } = yield* login(integrations)
          expect(attempt.mode).toBe("auto")
          expect(auth.origin + auth.pathname).toBe("https://claude.ai/oauth/authorize")
          expect(auth.searchParams.get("code")).toBe("true")
          expect(auth.searchParams.get("client_id")).toBe(bundledClientID)
          expect(auth.searchParams.get("code_challenge_method")).toBe("S256")
          expect(auth.searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/callback$/)

          const page = yield* Effect.promise(() => fetch(callback).then((res) => res.text()))
          expect(page).toContain("Claude")
          expect(yield* settle(integrations, attempt.attemptID)).toMatchObject({ status: "complete" })
          expect(requests).toHaveLength(1)
          expect(requests[0]).toMatchObject({
            grant_type: "authorization_code",
            client_id: bundledClientID,
            code: "auth-code",
            state: auth.searchParams.get("state"),
            redirect_uri: auth.searchParams.get("redirect_uri"),
          })
          expect(String(requests[0]?.code_verifier)).toHaveLength(43)

          const saved = (yield* credentials.list(integrationID))[0]?.value
          expect(saved).toMatchObject({ type: "oauth", methodID, access: "sk-ant-access" })
          if (saved?.type !== "oauth") throw new Error("Expected OAuth credential")
          expect(saved.metadata).toMatchObject({
            accountID: "acct-1",
            email: "user@example.com",
            clientID: bundledClientID,
          })
        }),
      ),
    { timeout: 20_000 },
  )

  it.live(
    "retries a 429 exchange and completes the login",
    () =>
      scenario([throttled, { status: 200, body: tokenBody }], ({ requests }) =>
        Effect.gen(function* () {
          const { integrations } = yield* setup
          const { attempt, callback } = yield* login(integrations)
          yield* Effect.promise(() => fetch(callback))
          expect(yield* settle(integrations, attempt.attemptID)).toMatchObject({ status: "complete" })
          expect(requests).toHaveLength(2)
        }),
      ),
    { timeout: 20_000 },
  )

  it.live(
    "fails with a clear throttle message after bounded retries and exchanges the code only once",
    () =>
      scenario([throttled, throttled, throttled, throttled], ({ requests }) =>
        Effect.gen(function* () {
          const { integrations, credentials } = yield* setup
          const { attempt, callback } = yield* login(integrations)
          const first = yield* Effect.promise(() => fetch(callback)).pipe(Effect.forkScoped({ startImmediately: true }))
          // Once the retry loop is running the callback page is still open; a second hit
          // (browser prefetch or refresh) must not start a second exchange.
          yield* Effect
            .sync(() => requests.length < 2)
            .pipe(Effect.repeat({ until: (more) => !more, schedule: Schedule.spaced("20 millis") }), Effect.timeout("5 seconds"))
          const repeat = yield* Effect.promise(() => fetch(callback))
          expect(repeat.status).toBe(409)
          expect(yield* Effect.promise(() => repeat.text())).toContain("already received")

          const result = yield* settle(integrations, attempt.attemptID, "20 seconds")
          expect(result).toMatchObject({ status: "failed" })
          expect((result as { message?: string }).message).toContain("Claude token exchange failed: 429")
          expect((result as { message?: string }).message).toContain("rate_limit_error")
          expect((result as { message?: string }).message).toContain("start sign-in again")
          expect(requests).toHaveLength(4)
          yield* Fiber.join(first).pipe(Effect.orElseSucceed(() => undefined))
          expect(yield* credentials.list(integrationID)).toEqual([])
        }),
      ),
    { timeout: 25_000 },
  )

  it.live("uses ANTHROPIC_OAUTH_CLIENT_ID for the authorize request and the exchange", () =>
    scenario([{ status: 200, body: tokenBody }], ({ requests }) =>
      withEnv({ ANTHROPIC_OAUTH_CLIENT_ID: "custom-client" }, () =>
        Effect.gen(function* () {
          const { integrations } = yield* setup
          const { attempt, url: auth, callback } = yield* login(integrations)
          expect(auth.searchParams.get("client_id")).toBe("custom-client")
          yield* Effect.promise(() => fetch(callback))
          expect(yield* settle(integrations, attempt.attemptID)).toMatchObject({ status: "complete" })
          expect(requests).toHaveLength(1)
          expect(requests[0]?.client_id).toBe("custom-client")
        }),
      ),
    ),
  { timeout: 20_000 })
})
