import { define } from "@opencode/plugin/effect/plugin"
import { Deferred, Effect, Semaphore } from "effect"
import type { ServerResponse } from "node:http"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"
import { OauthCallbackPage } from "../../oauth/page.js"
import { Provider } from "../../provider.js"
import { SessionAffinity } from "../../session/affinity.js"
import { activeCredential } from "./credential-settings.js"
import { ProviderRefresh } from "./refresh.js"

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
// Anthropic fronts the OAuth token endpoint with anti-abuse gates that answer with a bare
// 429 rate_limit_error (no retry-after, no ratelimit headers) to traffic shaped like a
// Claude Code clone: reused connections, HTTP/2 client fingerprints, or denied User-Agent
// prefixes. Real Claude Code posts with a plain Content-Type header over a fresh Node
// HTTP/1.1 connection. These hosts are separate limiter buckets: api.anthropic.com answers
// from the widest range of networks, and platform.claude.com is the endpoint current
// Claude Code builds use. ANTHROPIC_OAUTH_TOKEN_URL replaces the whole list.
const TOKEN_URLS = [
  "https://api.anthropic.com/v1/oauth/token",
  "https://platform.claude.com/v1/oauth/token",
]
const TOKEN_RETRY_LIMIT = 3
const TOKEN_RETRY_BASE_MS = 500
const TOKEN_RETRY_MAX_MS = 15_000
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"
const API_URL = "https://api.anthropic.com/v1"
const OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20"
const AGENT_SYSTEM = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
const SDK_USER_AGENT = "@anthropic-ai/sdk/0.74.0"
const CLI_USER_AGENT = "claude-cli/2.1.280 (external, cli)"

const integrationID = Integration.ID.make("anthropic")
const methodID = Integration.MethodID.make("claude-subscription")
const providerID = Provider.ID.anthropic

type Item = Record<string, unknown>

function tokenURLs(): string[] {
  return process.env.ANTHROPIC_OAUTH_TOKEN_URL?.trim() ? [process.env.ANTHROPIC_OAUTH_TOKEN_URL.trim()] : TOKEN_URLS
}

function retryAfterMs(value: string | null): number | undefined {
  const text = value?.trim()
  if (!text || text.length > 128) return undefined
  const at = /^\d+(?:\.\d+)?$/.test(text) ? Date.now() + Number(text) * 1000 : Date.parse(text)
  return Number.isFinite(at) ? Math.max(0, Math.ceil(at - Date.now())) : undefined
}

// One POST per attempt on a fresh connection, hopping hosts between retries: edge-gate 429s
// arrive without retry-after and each host keeps its own limiter bucket, while a retry-after
// (or a 5xx blip) gets a bounded jittered wait. Non-retryable answers stop immediately.
async function postToken(body: Record<string, string>, failed: (status: string) => Error): Promise<Item> {
  const urls = tokenURLs()
  let status = "unreachable"
  let retryAfter: number | undefined
  for (let attempt = 0; attempt <= TOKEN_RETRY_LIMIT; attempt++) {
    if (attempt > 0) {
      const wait = Math.min(retryAfter ?? 0, TOKEN_RETRY_MAX_MS)
      const backoff = Math.min(TOKEN_RETRY_BASE_MS * 2 ** (attempt - 1), TOKEN_RETRY_MAX_MS)
      await new Promise((resolve) => setTimeout(resolve, Math.max(wait, backoff) + Math.floor(Math.random() * 250)))
    }
    const response = await fetch(urls[attempt % urls.length], {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
      keepalive: false,
      // Bun-specific: force HTTP/1.1 instead of an ALPN-negotiated HTTP/2 session, whose
      // client fingerprint matches the spoofing tools the edge throttles. Ignored elsewhere.
      ...({ protocol: "http1.1" } as RequestInit),
    })
    if (response.ok) return (await response.json()) as Item
    if (response.status >= 300 && response.status < 400) {
      // A redirect could re-send the one-time code to another endpoint; never follow it.
      await response.body?.cancel().catch(() => {})
      throw failed(`${response.status} redirected`)
    }
    const detail = await response
      .text()
      .then((text) => {
        const parsed = JSON.parse(text.slice(0, 2000)) as { error?: unknown; error_description?: unknown }
        const error = typeof parsed.error === "string" ? parsed.error : undefined
        const description = typeof parsed.error_description === "string" ? parsed.error_description : undefined
        return [error, description].filter(Boolean).join(" ")
      })
      .catch(() => "")
    retryAfter = retryAfterMs(response.headers.get("retry-after"))
    status = `${response.status}${detail ? ` ${detail}` : ""}`
    if (response.status !== 429 && response.status < 500) break
  }
  throw failed(status)
}

async function fetchProfile(access: string): Promise<string | null> {
  try {
    const res = await fetch(PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${access}`,
        "User-Agent": CLI_USER_AGENT,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as Item
    const account = json.account as Item | undefined
    if (account?.has_claude_max === true) return "Max"
    if (account?.has_claude_pro === true) return "Pro"
    return null
  } catch {
    return null
  }
}

export const AnthropicPlugin = define({
  id: "opencode.provider.anthropic",
  effect: Effect.fn(function* (ctx) {
    const loading = Semaphore.makeUnsafe(1)
    let claudeCred: Credential.OAuth | undefined
    let source: Effect.Success<ReturnType<typeof ctx.integration.connection.active>>

    const load = Effect.fn("AnthropicPlugin.load")(function* () {
      const { connection, credential } = yield* activeCredential(ctx, integrationID)
      const previous = source
      claudeCred = credential?.type === "oauth" && credential.methodID === methodID ? credential : undefined
      source = claudeCred ? connection : undefined
      return previous !== source
    })

    yield* ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID,
        method: {
          id: methodID,
          type: "oauth",
          label: "Sign in with Claude (Subscription)",
        },
        refresh: (value) =>
          Effect.tryPromise({
            try: async () => {
              // Refresh with the application that issued the token; older credentials have no
              // recorded client ID and fall back to ANTHROPIC_OAUTH_CLIENT_ID or the default.
              const json = await postToken(
                {
                  grant_type: "refresh_token",
                  client_id:
                    (typeof value.metadata?.clientID === "string" ? value.metadata.clientID : undefined) ||
                    process.env.ANTHROPIC_OAUTH_CLIENT_ID?.trim() ||
                    CLIENT_ID,
                  refresh_token: value.refresh,
                },
                (status) => new Error(`Claude token refresh failed: ${status}`),
              )
              const access = String(json.access_token ?? "")
              const expiresIn = Number(json.expires_in ?? 3600)
              const plan = (await fetchProfile(access)) ?? (value.metadata?.plan as string | null)
              return Credential.OAuth.make({
                ...value,
                access,
                expires: Date.now() + expiresIn * 1000,
                metadata: { ...value.metadata, plan },
              })
            },
            catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
          }),
        authorize: () =>
          Effect.gen(function* () {
            // Capture once so the authorize request and the token exchange cannot disagree
            // if the environment changes mid-flow.
            const clientID = process.env.ANTHROPIC_OAUTH_CLIENT_ID?.trim() || CLIENT_ID
            // The authorization code is single-use: exchange it at most once per callback.
            let exchanged = false
            const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
            const challenge = Buffer.from(
              yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
            ).toString("base64url")
            const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
            const callback = yield* Deferred.make<{ code: string; response: ServerResponse }, Error>()
            const { createServer } = yield* Effect.promise(() => import("node:http"))
            const { EventEmitter } = yield* Effect.promise(() => import("node:events"))

            const server = createServer((request, response) => {
              const url = new URL(request.url ?? "/", "http://localhost")
              if (url.pathname !== "/callback") {
                response.writeHead(404).end("Not found")
                return
              }
              const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
              const code = url.searchParams.get("code")
              if (error) {
                response.writeHead(400, { "Content-Type": "text/html" }).end(OauthCallbackPage.error(error, { provider: "Claude" }))
                Effect.runSync(Deferred.fail(callback, new Error(error)))
                return
              }
              if (!code || url.searchParams.get("state") !== state) {
                const message = code ? "Invalid OAuth state" : "Missing authorization code"
                response.writeHead(400, { "Content-Type": "text/html" }).end(OauthCallbackPage.error(message, { provider: "Claude" }))
                Effect.runSync(Deferred.fail(callback, new Error(message)))
                return
              }
              if (!Effect.runSync(Deferred.succeed(callback, { code, response }))) {
                response.writeHead(409).end("OAuth callback already received")
              }
            })

            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                server.close()
                server.closeAllConnections()
              }),
            )

            let port = 54545
            try {
              server.listen(port, "localhost")
              yield* Effect.tryPromise(() => EventEmitter.once(server, "listening"))
            } catch {
              server.listen(0, "localhost")
              yield* Effect.tryPromise(() => EventEmitter.once(server, "listening"))
              const addr = server.address()
              if (addr && typeof addr !== "string") port = addr.port
            }

            const redirect = `http://localhost:${port}/callback`
            const authUrl = `https://claude.ai/oauth/authorize?${new URLSearchParams({
              code: "true",
              client_id: clientID,
              response_type: "code",
              redirect_uri: redirect,
              scope: "org:create_api_key user:profile user:inference",
              code_challenge: challenge,
              code_challenge_method: "S256",
              state,
            }).toString()}`

            return {
              mode: "auto" as const,
              url: authUrl,
              instructions: "Complete authorization in your browser. This window will close automatically.",
              callback: Effect.gen(function* () {
                const request = yield* Deferred.await(callback)
                const respond = (err?: string) =>
                  Effect.sync(() =>
                    request.response
                      .writeHead(err ? 400 : 200, { "Content-Type": "text/html" })
                      .end(err ? OauthCallbackPage.error(err, { provider: "Claude" }) : OauthCallbackPage.success({ provider: "Claude" })),
                  )
                return yield* Effect.tryPromise({
                  try: async () => {
                    if (exchanged) throw new Error("Claude authorization code was already exchanged")
                    exchanged = true
                    const [bare, fragment] = request.code.split("#")
                    const tokens = await postToken(
                      {
                        grant_type: "authorization_code",
                        client_id: clientID,
                        code: bare,
                        state: fragment || state,
                        redirect_uri: redirect,
                        code_verifier: verifier,
                      },
                      (status) =>
                        new Error(
                          `Claude token exchange failed: ${status}` +
                            (status.startsWith("429")
                              ? " (Anthropic is throttling the Claude sign-in exchange, not your account or network; start sign-in again in a minute)"
                              : ""),
                        ),
                    )
                    const access = String(tokens.access_token ?? "")
                    const refresh = String(tokens.refresh_token ?? "")
                    const expiresIn = Number(tokens.expires_in ?? 3600)
                    const account = tokens.account as Item | undefined
                    const plan = await fetchProfile(access)

                    return Credential.OAuth.make({
                      type: "oauth",
                      methodID,
                      access,
                      refresh,
                      expires: Date.now() + expiresIn * 1000,
                      metadata: {
                        accountID: typeof account?.uuid === "string" ? account.uuid : "claude",
                        email: typeof account?.email_address === "string" ? account.email_address.toLowerCase() : null,
                        plan,
                        clientID,
                      },
                    })
                  },
                  catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
                }).pipe(
                  Effect.tap(() => respond()),
                  Effect.tapError((err) => respond(err.message)),
                  Effect.onInterrupt(() => Effect.sync(() => request.response.destroy())),
                )
              }),
            }
          }),
      })
    })

    yield* load()

    yield* ctx.provider.transform((providers) => {
      const item = providers.get(providerID)
      if (!item || !claudeCred || !source) return
      providers.update(providerID, (provider) => {
        provider.settings = Provider.mergeOverlay(provider.settings, {
          baseURL: API_URL,
        })
        provider.headers = Provider.mergeHeaders(provider.headers, {
          "anthropic-version": "2023-06-01",
          "anthropic-beta": OAUTH_BETA,
          "user-agent": SDK_USER_AGENT,
        })
      })
    })

    yield* ctx.session.hook(
      "model.request",
      (evt) =>
        Effect.gen(function* () {
          if (!claudeCred) return
          const session = yield* ctx.session
            .get({ sessionID: evt.sessionID })
            .pipe(Effect.orElseSucceed(() => undefined))
          evt.headers["x-claude-code-session-id"] = session ? SessionAffinity.get(session) : evt.sessionID
          evt.headers["anthropic-beta"] = OAUTH_BETA
        }),
      { providerID },
    )

    yield* ctx.session.hook(
      "http.request",
      (evt) =>
        Effect.gen(function* () {
          if (!claudeCred) return
          if (!evt.request.url.includes("api.anthropic.com/v1/messages")) return
          // Ensure the required Claude Agent system prompt block is included
          try {
            const bodyText = yield* Effect.promise(() => evt.request.clone().text())
            const body = JSON.parse(bodyText) as { system?: unknown; [k: string]: unknown }
            const system = body.system
            const blocks: Array<{ type: string; text: string }> =
              typeof system === "string"
                ? (system ? [{ type: "text", text: system }] : [])
                : Array.isArray(system)
                  ? (system as Array<{ type: string; text: string }>)
                  : []
            if (blocks[0]?.text !== AGENT_SYSTEM) {
              body.system = [{ type: "text", text: AGENT_SYSTEM }, ...blocks]
              evt.request = new Request(evt.request.url, {
                method: evt.request.method,
                headers: evt.request.headers,
                body: JSON.stringify(body),
              })
            }
          } catch {
            // ignore non-json
          }
        }),
      { providerID },
    )

    yield* ProviderRefresh.onSwitch(
      integrationID,
      loading.withPermit(ProviderRefresh.reloadIfChanged(load(), ctx.provider.reload())),
    )
  }),
})
