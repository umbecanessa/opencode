import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { AnthropicPlugin } from "@opencode/core/plugin/provider/anthropic"
import { Provider } from "@opencode/core/provider"
import { expect } from "bun:test"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const integrationID = Integration.ID.make("anthropic")
const providerID = Provider.ID.anthropic
const methodID = Integration.MethodID.make("claude-subscription")

const fixture = Effect.gen(function* () {
  const integrations = yield* Integration.Service
  const credentials = yield* Credential.Service
  const providers = yield* Provider.Service

  yield* providers.transform((editor) => {
    editor.update(providerID, (provider) => {
      provider.package = "@opencode/ai/providers/anthropic"
      provider.settings = { baseURL: "https://api.anthropic.com/v1" }
    })
  })

  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin, "test")
  yield* AnthropicPlugin.effect(host)

  return { integrations, credentials, providers }
})

it.effect("registers Claude subscription OAuth method on anthropic integration", () =>
  Effect.gen(function* () {
    const { integrations } = yield* fixture
    const info = yield* integrations.get(integrationID)
    const method = info?.methods.find((m) => m.type === "oauth" && m.id === methodID) as
      | Integration.OAuthMethod
      | undefined

    expect(method).toBeDefined()
    expect(method?.type).toBe("oauth")
    expect(method?.label).toBe("Sign in with Claude (Subscription)")
  }),
)

it.effect("updates provider settings and headers when Claude subscription is connected", () =>
  Effect.gen(function* () {
    const { credentials, providers } = yield* fixture

    const created = yield* credentials.create({
      integrationID,
      value: Credential.OAuth.make({
        type: "oauth",
        methodID,
        access: "sk-ant-oauth-test",
        refresh: "refresh-test",
        expires: Date.now() + 3600_000,
        metadata: { plan: "Max", email: "user@example.com" },
      }),
    })
    yield* credentials.activate(created.id)

    const list = yield* providers.available()
    const anthropic = list.find((p) => p.id === providerID)

    expect(anthropic).toBeDefined()
    expect(anthropic?.headers?.["anthropic-version"]).toBe("2023-06-01")
    expect(anthropic?.headers?.["anthropic-beta"]).toContain("claude-code-20250219")
    expect(anthropic?.headers?.["user-agent"]).toBe("@anthropic-ai/sdk/0.74.0")
  }),
)
