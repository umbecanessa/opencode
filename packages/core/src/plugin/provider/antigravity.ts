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
// The backend gates model availability by client family in the User-Agent, not by plan. The
// gemini-4-* family is absent from :fetchAvailableModels and answers 404 to streamGenerateContent
// under the IDE family above, while the CLI family below unlocks it (verified live 2026-11-22;
// same split opencodex documents in src/adapters/client-fingerprint.ts). Gemini 3.x and Claude
// rows work under both families.
const CLI_VERSION = "1.3.4"
const CLI_USER_AGENT = `antigravity/cli/${CLI_VERSION} (os_type=windows; arch=amd64; aidev_client; auth_method=oauth)`
/** The User-Agent an inference request for `modelId` must carry. */
const userAgentForModel = (modelId: string) => (modelId.startsWith("gemini-4-") ? CLI_USER_AGENT : USER_AGENT)
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

// Fallback shown before the account's real roster arrives and when :fetchAvailableModels is
// unreachable. Every id here is a wire id verified to answer on live backends (2026-11); the
// roster endpoint stays the source of truth. Rows carry the default thinking level suffix because
// the wire only accepts the per-level ids.
const DEFAULT_MODELS = [
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", reasoning: false },
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", reasoning: true },
  { id: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen (Medium)", reasoning: true },
  { id: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)", reasoning: true },
  { id: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)", reasoning: true },
  { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)", reasoning: true },
  { id: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)", reasoning: true },
  { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)", reasoning: true },
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

// The models the account is actually served, in wire form and with Google's display names. The
// production endpoint answers for most accounts; the daily endpoint that streams responses is the
// fallback. Yields undefined when both are unreachable or list nothing, so the caller keeps its
// previous list. Never throws: fetch and JSON failures fall through to the next endpoint.
// The models the account is actually served. Each backend answers with whatever roster belongs to
// the client family the request claims, and the CLI family is the one that lists the gemini-4-*
// family, so both families are asked on both backends and the results are merged; a displayName from
// either family names the entry. Yields undefined when every call fails or lists nothing, so the
// caller keeps its previous list. Never throws: fetch and JSON failures fall through.
export async function fetchAvailableModels(access: string, project: string): Promise<{ id: string; name: string }[] | undefined> {
  const merged = new Map<string, string>()
  const ask = async (base: string, agent: string) => {
    try {
      const res = await fetch(`${base}:fetchAvailableModels`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access}`,
          "Content-Type": "application/json",
          "User-Agent": agent,
        },
        body: JSON.stringify(project ? { project } : {}),
      })
      if (!res.ok) return
      const models = ((await res.json()) as Item)?.models
      if (!models || typeof models !== "object" || Array.isArray(models)) return
      for (const [id, info] of Object.entries(models as Record<string, Item | null>)) {
        // Internal helper rows (tab-completion and chat backchannels) and the hidden -sonar
        // rollout stubs are served alongside the real lineup but are not selectable models.
        if (id.length === 0 || /^(tab_|chat_)/.test(id) || id.endsWith("-sonar")) continue
        const display = typeof info?.displayName === "string" && info.displayName.length > 0 ? info.displayName : undefined
        if (display !== undefined) merged.set(id, display)
        else if (!merged.has(id)) merged.set(id, id)
      }
    } catch {
      // Next backend or client family.
    }
  }
  for (const agent of [CLI_USER_AGENT, USER_AGENT]) {
    for (const base of [PROD_API, DAILY_API]) await ask(base, agent)
  }
  if (merged.size === 0) return undefined
  return [...merged].map(([id, name]) => ({ id, name }))
}

export const AntigravityPlugin = define({
  id: "opencode.provider.google-antigravity",
  effect: Effect.fn(function* (ctx) {
    const loading = Semaphore.makeUnsafe(1)
    let antigravityCred: Credential.OAuth | undefined
    let source: Effect.Success<ReturnType<typeof ctx.integration.connection.active>>
    let roster: { id: string; name: string }[] | undefined

    const load = Effect.fn("AntigravityPlugin.load")(function* () {
      const { connection, credential } = yield* activeCredential(ctx, integrationID)
      const previous = source
      antigravityCred = credential?.type === "oauth" && credential.methodID === methodID ? credential : undefined
      source = antigravityCred ? connection : undefined
      if (previous !== source) roster = undefined
      return previous !== source
    })

    // Applies the account's model roster as soon as it answers; a failed fetch keeps the roster
    // already registered, and a first fetch that fails leaves the static fallback in place.
    const refreshModels = Effect.fn("AntigravityPlugin.refreshModels")(function* () {
      const cred = antigravityCred
      if (!cred) return
      const next = yield* Effect.promise(() =>
        fetchAvailableModels(cred.access, typeof cred.metadata?.project === "string" ? cred.metadata.project : ""),
      )
      if (next === undefined) return
      roster = next
      yield* ctx.provider.reload()
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
      const models = (roster ?? DEFAULT_MODELS).map((m) =>
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
        // Hook events carry the npm specifier with the aisdk: prefix removed (Provider.packageName),
        // so compare against the bare name like the other provider plugins do.
        if (evt.package !== Provider.packageName(PACKAGE)) return
        const cred = antigravityCred
        if (!cred) return
        const project = typeof cred.metadata?.project === "string" ? cred.metadata.project : ""

        const antigravityFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const body = JSON.parse(init?.body as string) as Record<string, unknown>
          const modelId = String(body.model ?? "gemini-3.8-flash-medium")
          const isGemini = /gemini/i.test(modelId)
          const request = chatToGemini(body, { signatureFallback: isGemini })
          request.sessionId = geminiSessionId(body)

          const upstream = await fetch(`${DAILY_API}:streamGenerateContent?alt=sse`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${cred.access}`,
              "Content-Type": "application/json",
              Accept: "text/event-stream",
              "User-Agent": userAgentForModel(modelId),
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
      loading.withPermit(ProviderRefresh.reloadIfChanged(load(), ctx.provider.reload())).pipe(Effect.andThen(refreshModels())),
    )

    yield* Effect.forkScoped(refreshModels(), { startImmediately: true })
  }),
})
