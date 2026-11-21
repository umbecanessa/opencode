import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { AntigravityPlugin, fetchAvailableModels } from "@opencode/core/plugin/provider/antigravity"
import { Provider } from "@opencode/core/provider"
import { expect } from "bun:test"
import { Effect, Schedule } from "effect"
import { withEnv } from "../fixture/env"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const integrationID = Integration.ID.make("google-antigravity")
const providerID = Provider.ID.make("google-antigravity")
const methodID = Integration.MethodID.make("oauth")

function withFetch<A, E, R>(handler: (url: string) => Response | Promise<Response>, body: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = globalThis.fetch
      globalThis.fetch = ((input: Parameters<typeof fetch>[0]) =>
        handler(
          typeof input === "string" ? input : input instanceof URL ? input.toString() : String((input as Request).url ?? input),
        )) as typeof fetch
      return previous
    }),
    () => body,
    (previous) =>
      Effect.sync(() => {
        globalThis.fetch = previous
      }),
  )
}

const fixture = Effect.gen(function* () {
  const integrations = yield* Integration.Service
  const credentials = yield* Credential.Service
  const providers = yield* Provider.Service

  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin, "test")
  yield* AntigravityPlugin.effect(host)

  return { integrations, credentials, providers }
})

it.effect("registers Antigravity OAuth method on google-antigravity integration", () =>
  Effect.gen(function* () {
    const { integrations } = yield* fixture
    const info = yield* integrations.get(integrationID)
    const method = info?.methods.find((m) => m.type === "oauth" && m.id === methodID) as
      | Integration.OAuthMethod
      | undefined

    expect(method).toBeDefined()
    expect(method?.type).toBe("oauth")
    expect(method?.label).toBe("Sign in with Google (Antigravity)")
  }),
)

it.effect("registers provider and models when Antigravity is connected", () =>
  withFetch(
    () => new Response(null, { status: 503 }),
    Effect.gen(function* () {
      const { credentials, providers } = yield* fixture

      const created = yield* credentials.create({
        integrationID,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: "google-antigravity-token",
          refresh: "refresh-token",
          expires: Date.now() + 3600_000,
          metadata: { project: "test-project-123", plan: "Pro" },
        }),
      })
      yield* credentials.activate(created.id)

      const list = yield* providers.available()
      const antigravity = list.find((p) => p.id === providerID)

      expect(antigravity).toBeDefined()
      expect(antigravity?.name).toBe("Google Antigravity")
      expect(antigravity?.canonical).toBe(Provider.ID.google)

      const snap = yield* providers.snapshot()
      const record = snap.records.get(providerID)
      const models = record?.models ? Array.from(record.models.values()) : []
      expect(models.length).toBeGreaterThan(0)
      expect(models.some((m) => m.id === "gemini-3.8-flash")).toBe(true)
      expect(models.some((m) => m.id === "gemini-4-neon")).toBe(true)
      expect(models.some((m) => m.id === "claude-sonnet-5-5-medium")).toBe(true)
      expect(models.some((m) => m.id === "gemini-2.5-flash")).toBe(false)
    }),
  ),
)

it.live("begins sign-in with the bundled public Google client when nothing is configured", () =>
  withEnv({ ANTIGRAVITY_OAUTH_CLIENT_ID: undefined, ANTIGRAVITY_OAUTH_CLIENT_SECRET: undefined }, () =>
    Effect.gen(function* () {
      const { integrations } = yield* fixture
      const attempt = yield* integrations.oauth.connect({ integrationID, methodID })
      const url = new URL(attempt.url)
      expect(url.searchParams.get("client_id")).toBe("1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com")
    }),
  ),
)

it.live("begins sign-in with a custom client ID when its secret is configured", () =>
  withEnv({ ANTIGRAVITY_OAUTH_CLIENT_ID: "custom-client.apps.googleusercontent.com", ANTIGRAVITY_OAUTH_CLIENT_SECRET: "test-client-secret" }, () =>
    Effect.gen(function* () {
      const { integrations } = yield* fixture
      const attempt = yield* integrations.oauth.connect({ integrationID, methodID })
      const url = new URL(attempt.url)
      expect(url.searchParams.get("client_id")).toBe("custom-client.apps.googleusercontent.com")
    }),
  ),
)

it.effect("fails sign-in when ANTIGRAVITY_OAUTH_CLIENT_ID is overridden without a paired secret", () =>
  withEnv({ ANTIGRAVITY_OAUTH_CLIENT_ID: "custom-client.apps.googleusercontent.com", ANTIGRAVITY_OAUTH_CLIENT_SECRET: undefined }, () =>
    Effect.gen(function* () {
      const { integrations } = yield* fixture
      const error = yield* integrations.oauth.connect({ integrationID, methodID }).pipe(Effect.flip)
      expect(error.message).toContain("ANTIGRAVITY_OAUTH_CLIENT_SECRET")
      expect(error.message).toContain("custom-client.apps.googleusercontent.com")
      expect(error.message).toContain("or unset both")
    }),
  ),
)

it.live("begins sign-in with the bundled client ID when a client secret is configured", () =>
  withEnv({ ANTIGRAVITY_OAUTH_CLIENT_ID: undefined, ANTIGRAVITY_OAUTH_CLIENT_SECRET: "test-client-secret" }, () =>
    Effect.gen(function* () {
      const { integrations } = yield* fixture
      const attempt = yield* integrations.oauth.connect({ integrationID, methodID })
      const url = new URL(attempt.url)
      expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
      expect(url.searchParams.get("client_id")).toBe("1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com")
      expect(url.searchParams.get("redirect_uri")?.startsWith("http://127.0.0.1:")).toBe(true)
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    }),
  ),
)

it.effect("maps the roster to wire ids with display names", () =>
  withFetch(
    (url) =>
      url.endsWith(":fetchAvailableModels")
        ? Response.json({
            models: {
              "gemini-4-neon": { displayName: "Gemini 4 Neon" },
              "claude-sonnet-5-5-medium": { quotaInfo: { isExhausted: false } },
            },
          })
        : new Response(null, { status: 404 }),
    Effect.gen(function* () {
      const roster = yield* Effect.promise(() => fetchAvailableModels("token", "project-1"))
      expect(roster).toEqual([
        { id: "gemini-4-neon", name: "Gemini 4 Neon" },
        { id: "claude-sonnet-5-5-medium", name: "claude-sonnet-5-5-medium" },
      ])
    }),
  ),
)

it.effect("falls back to the daily endpoint when the production endpoint fails", () =>
  withFetch(
    (url) =>
      url.startsWith("https://daily-cloudcode-pa.")
        ? Response.json({ models: { "gemini-4-hydrogen": { displayName: "Gemini 4 Hydrogen" } } })
        : new Response(null, { status: 503 }),
    Effect.gen(function* () {
      const roster = yield* Effect.promise(() => fetchAvailableModels("token", "project-1"))
      expect(roster).toEqual([{ id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" }])
    }),
  ),
)

it.effect("reports no roster when every endpoint fails or lists nothing", () =>
  withFetch(
    (url) =>
      url.endsWith("daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels")
        ? Response.json({ models: {} })
        : Promise.reject(new Error("offline")),
    Effect.gen(function* () {
      const roster = yield* Effect.promise(() => fetchAvailableModels("token", "project-1"))
      expect(roster).toBeUndefined()
    }),
  ),
)

it.live("replaces the static fallback with the account roster after sign-in", () =>
  withFetch(
    () =>
      Response.json({
        models: {
          "gemini-4-neon": { displayName: "Gemini 4 Neon" },
          "claude-opus-5-5-high": { displayName: "Claude Opus 5.5 (High)" },
        },
      }),
    Effect.gen(function* () {
      const { credentials, providers } = yield* fixture

      const created = yield* credentials.create({
        integrationID,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: "google-antigravity-token",
          refresh: "refresh-token",
          expires: Date.now() + 3600_000,
          metadata: { project: "test-project-123", plan: "Ultra" },
        }),
      })
      yield* credentials.activate(created.id)

      const listed = providers.snapshot().pipe(
        Effect.map((snap) => {
          const models = snap.records.get(providerID)?.models
          return models ? Array.from(models.values()) : []
        }),
      )
      const swapped = yield* listed.pipe(
        Effect.map((models) => models.some((m) => m.id === "claude-opus-5-5-high" && m.name === "Claude Opus 5.5 (High)")),
        Effect.filterOrFail((done) => done),
        Effect.retry({ schedule: Schedule.max([Schedule.exponential("10 millis"), Schedule.recurs(40)]) }),
      )
      expect(swapped).toBe(true)

      const models = yield* listed
      expect(models.some((m) => m.id === "claude-opus-5-5-high")).toBe(true)
      expect(models.some((m) => m.id === "gemini-3.8-flash")).toBe(false)
    }),
  ),
)
