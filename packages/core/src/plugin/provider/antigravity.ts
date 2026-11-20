import { define } from "@opencode/plugin/effect/plugin"
import { Deferred, Effect, Semaphore } from "effect"
import type { ServerResponse } from "node:http"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"
import { Model } from "../../model.js"
import { OauthCallbackPage } from "../../oauth/page.js"
import { Provider } from "../../provider.js"
import { createOpenaiCompatible } from "../../github-copilot/copilot-provider.js"
import { activeCredential } from "./credential-settings.js"
import { ProviderRefresh } from "./refresh.js"
import { chatToGemini, geminiSessionId, geminiStreamToChat, type Item } from "../../antigravity/wire.js"

// This is Google's own first-party Antigravity OAuth client, not a registration of ours. Google
// ships this id+secret pair inside its own Antigravity/Cloud Code products, so it is published
// openly in Google's distributions and in every open-source Antigravity/Gemini-CLI integrator
// (e.g. google-gemini/gemini-cli, NoeFabris/opencode-antigravity-auth, router-for-me/CLIProxyAPI).
// Bundling it matches how official tooling authenticates. Users with their own OAuth registration
// override both values through the environment, mirroring the GITLAB_OAUTH_CLIENT_ID pattern in gitlab.ts.
const DEFAULT_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
const DEFAULT_CLIENT_SECRET = "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"
const CALLBACK_PORT = 51121
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const PROD_API = "https://cloudcode-pa.googleapis.com/v1internal"
const DAILY_API = "https://daily-cloudcode-pa.googleapis.com/v1internal"
const IDE_VERSION = "2.5.5"
const USER_AGENT = `antigravity/ide/${IDE_VERSION} (os_type=windows; arch=amd64; aidev_client; auth_method=oauth)`
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
]

const integrationID = Integration.ID.make("google-antigravity")
const methodID = Integration.MethodID.make("oauth")
const providerID = Provider.ID.make("google-antigravity")
export const PACKAGE = Provider.aisdk("@ai-sdk/google-antigravity")

const DEFAULT_MODELS = [
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", reasoning: false },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", reasoning: false },
  { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", reasoning: true },
  { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", reasoning: false },
]

// Resolution order: env override first, then the bundled public Google client. A custom client ID
// with no paired secret fails closed below, because Google's public secret cannot authenticate a
// foreign client id.
function oauthClient(): { id: string; secret?: string } {
  const id = process.env.ANTIGRAVITY_OAUTH_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID
  const secret =
    process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim() || (id === DEFAULT_CLIENT_ID ? DEFAULT_CLIENT_SECRET : undefined)
  return { id, secret }
}

function missingClientSecret(client: { id: string }) {
  return new Error(
    `Google Antigravity sign-in cannot use ANTIGRAVITY_OAUTH_CLIENT_ID=${client.id} without a paired secret. ` +
      `Set ANTIGRAVITY_OAUTH_CLIENT_SECRET to the client secret of the OAuth client you registered at ` +
      `https://console.cloud.google.com/apis/credentials (redirect URI http://127.0.0.1:${CALLBACK_PORT}/callback), ` +
      `or unset both ANTIGRAVITY_OAUTH_CLIENT_* variables to sign in with the bundled Google client.`,
  )
}

function decodeJwtPayload(token: string | undefined): Item | null {
  const part = token?.split(".")[1]
  if (!part) return null
  try {
    const payload: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
    return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Item) : null
  } catch {
    return null
  }
}

function projectOf(data: Item | null): string | undefined {
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = data?.[key]
    if (typeof value === "string" && value) return value
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const id = (value as Item).id
      if (typeof id === "string" && id) return id
    }
  }
  return undefined
}

async function discoverProject(access: string): Promise<{ project: string; tier: string | null }> {
  const loadRes = await fetch(`${PROD_API}:loadCodeAssist`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
  })
  if (loadRes.ok) {
    const loaded = (await loadRes.json()) as Item
    const tier = loaded.currentTier as Item | undefined
    const tierName = typeof tier?.name === "string" ? tier.name : null
    const found = projectOf(loaded)
    if (found) return { project: found, tier: tierName }
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const onboardRes = await fetch(`${DAILY_API}:onboardUser`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        tier_id: "free-tier",
        metadata: { ide_type: "ANTIGRAVITY", ide_name: "antigravity", ide_version: IDE_VERSION },
      }),
    })
    if (onboardRes.ok) {
      const op = (await onboardRes.json()) as Item
      if (op.done === true) {
        const project = projectOf(op.response as Item | null)
        if (project) return { project, tier: null }
      }
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error("This Google account has no Gemini Code Assist / Antigravity access yet. Open antigravity.google once, then try again.")
}

export const AntigravityPlugin = define({
  id: "opencode.provider.google-antigravity",
  effect: Effect.fn(function* (ctx) {
    const loading = Semaphore.makeUnsafe(1)
    let antigravityCred: Credential.OAuth | undefined
    let source: Effect.Success<ReturnType<typeof ctx.integration.connection.active>>

    const load = Effect.fn("AntigravityPlugin.load")(function* () {
      const { connection, credential } = yield* activeCredential(ctx, integrationID)
      const previous = source
      antigravityCred = credential?.type === "oauth" && credential.methodID === methodID ? credential : undefined
      source = antigravityCred ? connection : undefined
      return previous !== source
    })

    yield* ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID,
        method: {
          id: methodID,
          type: "oauth",
          label: "Sign in with Google (Antigravity)",
        },
        refresh: (value) =>
          Effect.tryPromise({
            try: async () => {
              const client = oauthClient()
              if (!client.secret) throw missingClientSecret(client)
              const res = await fetch(TOKEN_URL, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                  grant_type: "refresh_token",
                  client_id: client.id,
                  client_secret: client.secret,
                  refresh_token: value.refresh,
                }).toString(),
              })
              if (!res.ok) throw new Error(`Google token refresh failed: ${res.status}`)
              const json = (await res.json()) as Item
              const access = String(json.access_token ?? "")
              const expiresIn = Number(json.expires_in ?? 3600)
              let project = typeof value.metadata?.project === "string" ? value.metadata.project : ""
              if (!project) {
                const discovered = await discoverProject(access)
                project = discovered.project
              }
              return Credential.OAuth.make({
                ...value,
                access,
                expires: Date.now() + expiresIn * 1000,
                metadata: { ...value.metadata, project },
              })
            },
            catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
          }),
        authorize: () =>
          Effect.gen(function* () {
            // Capture once so the authorize request and the token exchange cannot disagree
            // if the environment changes mid-flow. Fail closed before opening any listener.
            const client = oauthClient()
            if (!client.secret) return yield* Effect.fail(missingClientSecret(client))
            const clientSecret = client.secret
            const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
            const challenge = Buffer.from(
              yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
            ).toString("base64url")
            const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
            const callback = yield* Deferred.make<{ code: string; response: ServerResponse }, Error>()
            const { createServer } = yield* Effect.promise(() => import("node:http"))
            const { EventEmitter } = yield* Effect.promise(() => import("node:events"))

            const server = createServer((request, response) => {
              const url = new URL(request.url ?? "/", "http://127.0.0.1")
              if (url.pathname !== "/callback") {
                response.writeHead(404).end("Not found")
                return
              }
              const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
              const code = url.searchParams.get("code")
              if (error) {
                response.writeHead(400, { "Content-Type": "text/html" }).end(OauthCallbackPage.error(error, { provider: "Google" }))
                Effect.runSync(Deferred.fail(callback, new Error(error)))
                return
              }
              if (!code || url.searchParams.get("state") !== state) {
                const message = code ? "Invalid OAuth state" : "Missing authorization code"
                response.writeHead(400, { "Content-Type": "text/html" }).end(OauthCallbackPage.error(message, { provider: "Google" }))
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

            let port = CALLBACK_PORT
            try {
              server.listen(port, "127.0.0.1")
              yield* Effect.tryPromise(() => EventEmitter.once(server, "listening"))
            } catch {
              server.listen(0, "127.0.0.1")
              yield* Effect.tryPromise(() => EventEmitter.once(server, "listening"))
              const addr = server.address()
              if (addr && typeof addr !== "string") port = addr.port
            }

            const redirect = `http://127.0.0.1:${port}/callback`
            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
              response_type: "code",
              client_id: client.id,
              redirect_uri: redirect,
              scope: SCOPES.join(" "),
              code_challenge: challenge,
              code_challenge_method: "S256",
              access_type: "offline",
              prompt: "consent select_account",
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
                      .end(err ? OauthCallbackPage.error(err, { provider: "Google" }) : OauthCallbackPage.success({ provider: "Google" })),
                  )
                return yield* Effect.tryPromise({
                  try: async () => {
                    const tokenRes = await fetch(TOKEN_URL, {
                      method: "POST",
                      headers: { "Content-Type": "application/x-www-form-urlencoded" },
                      body: new URLSearchParams({
                        grant_type: "authorization_code",
                        client_id: client.id,
                        client_secret: clientSecret,
                        code: request.code,
                        redirect_uri: redirect,
                        code_verifier: verifier,
                      }).toString(),
                    })
                    if (!tokenRes.ok) throw new Error(`Google token exchange failed: ${tokenRes.status}`)
                    const tokens = (await tokenRes.json()) as Item
                    const access = String(tokens.access_token ?? "")
                    const refresh = String(tokens.refresh_token ?? "")
                    const expiresIn = Number(tokens.expires_in ?? 3600)
                    const idClaims = decodeJwtPayload(typeof tokens.id_token === "string" ? tokens.id_token : undefined)
                    const projectInfo = await discoverProject(access)

                    return Credential.OAuth.make({
                      type: "oauth",
                      methodID,
                      access,
                      refresh,
                      expires: Date.now() + expiresIn * 1000,
                      metadata: {
                        project: projectInfo.project,
                        plan: projectInfo.tier,
                        email: typeof idClaims?.email === "string" ? idClaims.email.toLowerCase() : null,
                        accountID: typeof idClaims?.sub === "string" ? idClaims.sub : "google",
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
      if (!antigravityCred || !source) return
      const models = DEFAULT_MODELS.map((m) =>
        Model.Info.make({
          ...Model.Info.default(providerID, Model.ID.make(m.id)),
          name: m.name,
          package: PACKAGE,
          status: "active",
          time: { released: Date.now() },
          limit: { context: 1_000_000, output: 64_000 },
          cost: [],
          enabled: true,
        }),
      )
      providers.add({
        info: Provider.Info.make({
          id: providerID,
          name: "Google Antigravity",
          package: PACKAGE,
          canonical: Provider.ID.google,
          activation: "enabled",
        }),
        models,
        sourceConnection: source,
      })
    })

    yield* ctx.aisdk.hook(
      "sdk",
      Effect.fn(function* (evt) {
        if (evt.package !== PACKAGE) return
        const cred = antigravityCred
        if (!cred) return
        const project = typeof cred.metadata?.project === "string" ? cred.metadata.project : ""

        const antigravityFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const body = JSON.parse(init?.body as string) as Record<string, unknown>
          const modelId = String(body.model ?? "gemini-2.5-flash")
          const isGemini = /gemini/i.test(modelId)
          const request = chatToGemini(body, { signatureFallback: isGemini })
          request.sessionId = geminiSessionId(body)

          const upstream = await fetch(`${DAILY_API}:streamGenerateContent?alt=sse`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${cred.access}`,
              "Content-Type": "application/json",
              Accept: "text/event-stream",
              "User-Agent": USER_AGENT,
            },
            body: JSON.stringify({
              model: modelId,
              userAgent: "antigravity",
              requestType: "agent",
              project,
              requestId: `agent-${crypto.randomUUID()}`,
              request,
            }),
            signal: init?.signal,
          })

          if (!upstream.ok || !upstream.body) {
            return upstream
          }

          const stream = geminiStreamToChat(upstream.body, modelId, Boolean((body.stream_options as Item | undefined)?.include_usage))
          return new Response(stream, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
            },
          })
        }

        evt.sdk = createOpenaiCompatible({
          name: "google-antigravity",
          baseURL: "https://daily-cloudcode-pa.googleapis.com/v1internal",
          fetch: antigravityFetch as typeof fetch,
        })
      }),
      { providerID },
    )

    yield* ProviderRefresh.onSwitch(
      integrationID,
      loading.withPermit(ProviderRefresh.reloadIfChanged(load(), ctx.provider.reload())),
    )
  }),
})
