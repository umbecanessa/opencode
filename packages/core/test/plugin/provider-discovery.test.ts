import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { DiscoveryPlugin, make } from "@opencode/core/plugin/provider/discovery"
import { ProviderPlugins } from "@opencode/core/plugin/provider"
import { Provider } from "@opencode/core/provider"
import { Document, Event, Info } from "@opencode/schema/config"
import { describe, expect } from "bun:test"
import { Duration, Effect, Layer, Schema } from "effect"
import { eventually } from "../lib/eventually"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(Layer.merge(PluginTestLayer, Config.testLayer()))
const decode = Schema.decodeUnknownSync(Info)
const providerID = Provider.ID.make("gateway")

const addPlugins = Effect.fn(function* (interval: Duration.Input = "1 hour") {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin, "test")
  yield* make(interval).effect(host)
  yield* ConfigProviderPlugin.Plugin.effect(host)
})

const modelOf = (id: string) =>
  Effect.gen(function* () {
    const models = yield* Model.Service
    return yield* models.get(providerID, Model.ID.make(id))
  })

describe("DiscoveryPlugin", () => {
  it.live("registers listed models, reads reported metadata, and lets configured models overlay them", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const requests: Array<{ authorization: string | null; path: string }> = []
        return {
          requests,
          server: Bun.serve({
            port: 0,
            fetch: (request) => {
              requests.push({ authorization: request.headers.get("authorization"), path: new URL(request.url).pathname })
              return Response.json({
                object: "list",
                data: [
                  {
                    id: "alpha",
                    context_length: 1_000_000,
                    max_output_tokens: 64_000,
                    capabilities: {
                      supports_tool_use: true,
                      supports_vision: true,
                      input_modalities: ["text", "image"],
                      output_modalities: ["text"],
                      reasoning_effort: ["low", "medium", "high"],
                    },
                  },
                  { id: "beta" },
                  { id: "image-only", capabilities: { output_modalities: ["image"] } },
                  42,
                ],
              })
            },
          }),
        }
      }),
      ({ requests, server }) =>
        Effect.gen(function* () {
          expect(DiscoveryPlugin.id).toBe("opencode.provider.discovery")
          expect(ProviderPlugins.map((item) => item.id)).toContain("opencode.provider.discovery")
          const config = yield* Config.Test
          yield* config.setEntries([
            document({
              gateway: {
                package: "@opencode/ai/providers/openai-compatible",
                settings: { baseURL: `${server.url.origin}/v1/`, apiKey: "secret" },
                models: { alpha: { name: "Alpha (configured)" } },
              },
              optout: {
                package: "@opencode/ai/providers/openai-compatible",
                discover: false,
                settings: { baseURL: `${server.url.origin}/optout/v1` },
              },
              native: {
                package: "@opencode/ai/providers/openai/responses",
                settings: { baseURL: `${server.url.origin}/native/v1` },
              },
              legacy: {
                package: "aisdk:@ai-sdk/openai-compatible",
                settings: { baseURL: `${server.url.origin}/legacy/v1` },
              },
              forced: {
                package: "@opencode/ai/providers/openai/responses",
                discover: true,
                settings: { baseURL: `${server.url.origin}/forced/v1` },
              },
            }),
          ])
          yield* addPlugins()
          const alpha = yield* eventually(modelOf("alpha"), (model) => model?.limit.context === 1_000_000)

          expect(alpha).toMatchObject({
            name: "Alpha (configured)",
            capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
            limit: { context: 1_000_000, output: 64_000 },
          })
          expect(alpha?.variants.map((variant) => variant.id)).toEqual(
            ["low", "medium", "high"].map((id) => Model.VariantID.make(id)),
          )
          expect(yield* modelOf("beta")).toMatchObject({
            name: "beta",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 200_000, output: 32_000 },
          })
          expect(yield* modelOf("image-only")).toBeUndefined()
          expect(requests).toContainEqual({ authorization: "Bearer secret", path: "/v1/models" })
          // `forced` and `legacy` are fetched too; give their requests time to land before judging the rest.
          yield* eventually(
            Effect.sync(() => requests.map((request) => request.path)),
            (paths) => paths.includes("/forced/v1/models") && paths.includes("/legacy/v1/models"),
          )
          const paths = requests.map((request) => request.path)
          expect(paths).not.toContain("/optout/v1/models")
          expect(paths).not.toContain("/native/v1/models")
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live(
    "refreshes the inventory, keeps it through failures, and drops it when discovery is turned off",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const state = { ids: ["one"], fail: false, failures: 0 }
          return {
            state,
            server: Bun.serve({
              port: 0,
              fetch: () => {
                if (state.fail) {
                  state.failures++
                  return new Response("unavailable", { status: 503 })
                }
                return Response.json({ data: state.ids.map((id) => ({ id })) })
              },
            }),
          }
        }),
        ({ state, server }) =>
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const config = yield* Config.Test
            const entries = (discover: boolean) => [
              document({
                gateway: {
                  package: "@opencode/ai/providers/openai-compatible",
                  discover,
                  settings: { baseURL: `${server.url.origin}/v1` },
                },
              }),
            ]
            yield* config.setEntries(entries(true))
            yield* addPlugins("5 millis")
            yield* eventually(modelOf("one"), (model) => model !== undefined)

            state.ids = ["one", "two"]
            yield* eventually(modelOf("two"), (model) => model !== undefined)

            state.fail = true
            yield* eventually(
              Effect.sync(() => state.failures),
              (count) => count >= 2,
            )
            expect(yield* modelOf("two")).toBeDefined()

            state.fail = false
            yield* config.setEntries(entries(false))
            yield* bus.publish(Event.Updated, {})
            yield* eventually(modelOf("two"), (model) => model === undefined)
            expect(yield* modelOf("one")).toBeUndefined()
          }),
        ({ server }) => Effect.promise(() => server.stop(true)),
      ),
    10_000,
  )
})

function document(providers: Record<string, unknown>) {
  return new Document({ type: "document", info: decode({ providers }) })
}
