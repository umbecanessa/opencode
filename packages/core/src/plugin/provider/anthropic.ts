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
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token"
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
              const res = await fetch(TOKEN_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify({
                  grant_type: "refresh_token",
                  client_id: CLIENT_ID,
                  refresh_token: value.refresh,
                }),
              })
              if (!res.ok) throw new Error(`Claude token refresh failed: ${res.status}`)
              const json = (await res.json()) as Item
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
              client_id: CLIENT_ID,
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
                    const [bare, fragment] = request.code.split("#")
                    const tokenRes = await fetch(TOKEN_URL, {
                      method: "POST",
                      headers: { "Content-Type": "application/json", Accept: "application/json" },
                      body: JSON.stringify({
                        grant_type: "authorization_code",
                        client_id: CLIENT_ID,
                        code: bare,
                        state: fragment || state,
                        redirect_uri: redirect,
                        code_verifier: verifier,
                      }),
                    })
                    if (!tokenRes.ok) throw new Error(`Claude token exchange failed: ${tokenRes.status}`)
                    const tokens = (await tokenRes.json()) as Item
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
