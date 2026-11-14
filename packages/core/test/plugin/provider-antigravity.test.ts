import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { AntigravityPlugin } from "@opencode/core/plugin/provider/antigravity"
import { Provider } from "@opencode/core/provider"
import { expect } from "bun:test"
import { Effect } from "effect"
import { withEnv } from "../fixture/env"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const integrationID = Integration.ID.make("google-antigravity")
const providerID = Provider.ID.make("google-antigravity")
const methodID = Integration.MethodID.make("oauth")

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
    expect(models.some((m) => m.id === "gemini-2.5-flash")).toBe(true)
    expect(models.some((m) => m.id === "gemini-2.5-pro")).toBe(true)
  }),
)

it.effect("fails sign-in when ANTIGRAVITY_OAUTH_CLIENT_SECRET is unset", () =>
  withEnv({ ANTIGRAVITY_OAUTH_CLIENT_ID: undefined, ANTIGRAVITY_OAUTH_CLIENT_SECRET: undefined }, () =>
    Effect.gen(function* () {
      const { integrations } = yield* fixture
      const error = yield* integrations.oauth.connect({ integrationID, methodID }).pipe(Effect.flip)
      expect(error.message).toContain("ANTIGRAVITY_OAUTH_CLIENT_SECRET")
      expect(error.message).toContain("console.cloud.google.com/apis/credentials")
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
