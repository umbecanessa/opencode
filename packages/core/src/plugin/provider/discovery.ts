import { define } from "@opencode/plugin/effect/plugin"
import type { Document, Entry } from "@opencode/schema/config"
import { Duration, Effect, Option, Schedule, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Config } from "../../config.js"
import { ConfigIntegration } from "../../config/integration.js"
import { Variant } from "../../variant.js"
import type { PluginInternal } from "../internal.js"
import { foldSettings } from "./configured.js"

const RemoteModel = Schema.Struct({
  id: Schema.String,
  context_length: Schema.Finite.pipe(Schema.optional),
  max_output_tokens: Schema.Finite.pipe(Schema.optional),
  capabilities: Schema.Struct({
    supports_tool_use: Schema.Boolean.pipe(Schema.optional),
    supports_vision: Schema.Boolean.pipe(Schema.optional),
    input_modalities: Schema.Array(Schema.String).pipe(Schema.optional),
    output_modalities: Schema.Array(Schema.String).pipe(Schema.optional),
    reasoning_effort: Schema.Array(Schema.String).pipe(Schema.optional),
  }).pipe(Schema.optional),
})

const Response = Schema.Struct({ data: Schema.Array(Schema.Unknown) })
const decodeModel = Schema.decodeUnknownOption(RemoteModel)

type Target = { readonly providerID: string; readonly baseURL: string; readonly apiKey?: string }
type Remote = typeof RemoteModel.Type

/**
 * Registers the models an OpenAI-compatible endpoint lists for every configured provider that uses an
 * OpenAI-compatible package, unless it sets `discover: false`. `discover: true` enables it for any other provider.
 * Fields beyond `id` are read when the endpoint reports them (context window, tool use, vision, reasoning efforts).
 * Discovered models are registered before configured models, so explicit `models` entries still overlay them.
 */
export const make = (interval: Duration.Input = "1 minute") =>
  define({
    id: "opencode.provider.discovery",
    effect: Effect.fn(function* (ctx) {
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      const config = yield* Config.Service
      const loaded = { models: new Map<string, { readonly baseURL: string; readonly items: readonly Remote[] }>(), hash: "[]" }

      yield* ctx.provider.transform((providers) => {
        for (const [providerID, found] of loaded.models)
          for (const item of found.items.filter(isText))
            providers.models.update(providerID, item.id, (model) => {
              model.capabilities = {
                tools: item.capabilities?.supports_tool_use ?? true,
                input: [...(item.capabilities?.input_modalities ?? ["text", ...(item.capabilities?.supports_vision ? ["image"] : [])])],
                output: ["text"],
              }
              if (item.context_length) model.limit.context = Math.trunc(item.context_length)
              if (item.max_output_tokens) model.limit.output = Math.trunc(item.max_output_tokens)
            })
      })

      // Variants are spelled for the provider's final package, which the configuration plugin only sets later.
      yield* ctx.model.transform((models) => {
        for (const [providerID, found] of loaded.models)
          for (const item of found.items.filter(isText)) {
            const efforts = (item.capabilities?.reasoning_effort ?? []).filter((effort) => effort !== "default")
            if (efforts.length === 0) continue
            models.update(providerID, item.id, (model) => {
              model.variants = [
                ...Variant.resolve(
                  { ...model, package: model.package ?? models.provider.get(providerID)?.provider.package },
                  [{ type: "effort", values: efforts }],
                ),
              ]
            })
          }
      })

      const list = Effect.fn("ProviderDiscovery.list")(function* (target: Target) {
        const request = HttpClientRequest.get(`${target.baseURL}/models`).pipe(HttpClientRequest.acceptJson)
        const response = yield* http
          .execute(target.apiKey ? request.pipe(HttpClientRequest.bearerToken(target.apiKey)) : request)
          .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Response)), Effect.timeout("10 seconds"))
        return response.data.flatMap((item) => Option.toArray(decodeModel(item)))
      })

      const refresh = Effect.fn("ProviderDiscovery.refresh")(function* () {
        const wanted = targets(yield* config.entries())
        // A failed fetch keeps the last inventory for the same endpoint instead of flickering model availability.
        const next = new Map(
          wanted.flatMap((target) => {
            const previous = loaded.models.get(target.providerID)
            return previous?.baseURL === target.baseURL ? [[target.providerID, previous] as const] : []
          }),
        )
        yield* Effect.forEach(
          wanted,
          (target) =>
            list(target).pipe(
              Effect.tap((items) => Effect.sync(() => next.set(target.providerID, { baseURL: target.baseURL, items }))),
              Effect.ignore,
            ),
          { concurrency: "unbounded" },
        )
        const hash = JSON.stringify([...next])
        if (hash === loaded.hash) return
        loaded.models = next
        loaded.hash = hash
        yield* ctx.provider.reload()
      })

      yield* refresh().pipe(Effect.ignore, Effect.repeat(Schedule.spaced(interval)), Effect.forkScoped)
      yield* ctx.event
        .subscribe({ types: ["config.updated"] })
        .pipe(Stream.runForEach(() => refresh().pipe(Effect.ignore)), Effect.forkScoped({ startImmediately: true }))
    }),
  } satisfies PluginInternal.InternalPlugin)

export const DiscoveryPlugin = make()

// Endpoints may list non-chat models; keep only those that produce text.
function isText(item: Remote) {
  return item.capabilities?.output_modalities?.includes("text") ?? true
}

// Providers on an OpenAI-compatible package are discovered unless they opt out; `discover: true` opts any provider in.
function targets(entries: readonly Entry[]): readonly Target[] {
  const configured = entries
    .filter((entry): entry is Document => entry.type === "document" && !(entry instanceof ConfigIntegration.Document))
    .flatMap((document) => Object.entries(document.info.providers ?? {}))
    .reduce(
      (providers, [id, provider]) =>
        providers.set(id, {
          discover: provider.discover ?? providers.get(id)?.discover,
          package: provider.package ?? providers.get(id)?.package,
        }),
      new Map<string, { readonly discover?: boolean; readonly package?: string }>(),
    )
  return [...configured].flatMap(([providerID, provider]) => {
    const settings =
      (provider.discover ?? provider.package?.includes("openai-compatible") === true)
        ? foldSettings(entries, providerID, undefined)
        : undefined
    if (typeof settings?.baseURL !== "string" || !URL.canParse(settings.baseURL)) return []
    return [
      {
        providerID,
        baseURL: settings.baseURL.replace(/\/+$/, ""),
        apiKey: typeof settings.apiKey === "string" && settings.apiKey.length > 0 ? settings.apiKey : undefined,
      },
    ]
  })
}
