export * as UsageLimits from "./usage-limits.js"

import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { UsageLimits } from "@opencode/schema/usage-limits"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { Context, Duration, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ConsoleAccess } from "./console-access.js"
import { Credential } from "./credential.js"
import { Integration } from "./integration.js"
import { Provider } from "./provider.js"

export const Info = UsageLimits.Info
export type Info = UsageLimits.Info

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("UsageLimits.UnavailableError", {
  message: Schema.String,
}) {}

export interface Interface {
  /** The usage limits of the OpenCode Console workspace this location is signed in to, if it is. */
  readonly get: () => Effect.Effect<Info | undefined, UnavailableError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/UsageLimits") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const integrations = yield* Integration.Service
    const providers = yield* Provider.Service
    const credentials = yield* Credential.Service
    const http = yield* HttpClient.HttpClient

    const get = Effect.fn("UsageLimits.get")(function* () {
      const [console, reported] = yield* Effect.all(
        [readConsole(integrations, http), readProviders(providers, integrations, credentials, http)],
        {
          concurrency: 2,
        },
      )
      if (console === undefined && reported.length === 0) return undefined
      return {
        ...console ?? { budgets: [] },
        ...(reported.length === 0 ? {} : { providers: reported }),
      }
    })

    return Service.of({ get })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Integration.node, Provider.node, Credential.node, httpClient],
})

/** The Console limits of the workspace the location is signed in to, or undefined when it isn't. */
const readConsole = Effect.fn("UsageLimits.readConsole")(function* (
  integrations: Integration.Interface,
  http: HttpClient.HttpClient,
) {
  const connection = yield* integrations.connection.active(Integration.ID.make("opencode"))
  if (!connection) return undefined
  const credential = yield* integrations.connection
    .resolve(connection)
    .pipe(Effect.mapError((error) => new UnavailableError({ message: error.message })))
  if (!credential || credential.type === "external") return undefined
  const workspaceID = credential.metadata?.orgID
  if (typeof workspaceID !== "string") return undefined
  const server = ConsoleAccess.server(credential)
  const [budgets, go] = yield* Effect.all(
    [readBudgets(http, server, credential), readGo(http, server, credential, workspaceID)],
    { concurrency: 2 },
  ).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(15),
      orElse: () => Effect.fail(new UnavailableError({ message: "OpenCode Console usage limits timed out" })),
    }),
  )
  return {
    workspace: {
      id: workspaceID,
      ...(typeof credential.metadata?.orgName === "string" ? { name: credential.metadata.orgName } : {}),
      usageURL: `${server}/${workspaceID}/activity/overview`,
    },
    ...(go === undefined ? {} : { go }),
    budgets,
  }
})

// A provider's usage endpoint answers with its windows; `resetsAt` is epoch millis or an ISO date, `limited`
// defaults to false when the endpoint only reports percentages, and `provider` names the upstream service when
// the endpoint aggregates several (a hub). Endpoints that only expose a dollar credit balance (OpenRouter) may
// answer with that instead, which reads as one window that never resets.
const ProviderWindow = Schema.Struct({
  label: Schema.optional(Schema.String),
  percent: Schema.Finite,
  limited: Schema.optional(Schema.Boolean),
  resetsAt: Schema.optional(Schema.Union([Schema.Finite, Schema.DateFromString])),
  resetsIn: Schema.optional(Schema.Finite),
  provider: Schema.optional(Schema.String),
  balance: Schema.optional(Schema.Finite),
})
const ProviderUsageResponse = Schema.Union([
  Schema.Struct({ windows: Schema.Array(ProviderWindow) }),
  Schema.Struct({ data: Schema.Struct({ total_credits: Schema.Finite, total_usage: Schema.Finite }) }),
])

const AntigravityBucket = Schema.Struct({
  window: Schema.optional(Schema.String),
  bucketId: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  remainingFraction: Schema.optional(Schema.Finite),
  remainingPercentage: Schema.optional(Schema.Finite),
  remaining: Schema.optional(
    Schema.Struct({
      remainingFraction: Schema.optional(Schema.Finite),
      remainingPercentage: Schema.optional(Schema.Finite),
    }),
  ),
  resetTime: Schema.optional(Schema.String),
})
const AntigravityGroup = Schema.Struct({
  displayName: Schema.optional(Schema.String),
  buckets: Schema.optional(Schema.Array(AntigravityBucket)),
})
const AntigravityQuotaResponse = Schema.Struct({
  groups: Schema.optional(Schema.Array(AntigravityGroup)),
})

const AnthropicBucket = Schema.Struct({
  utilization: Schema.optional(Schema.Finite),
  resets_at: Schema.optional(Schema.String),
})
const AnthropicUsageResponse = Schema.Struct({
  five_hour: Schema.optional(Schema.NullOr(AnthropicBucket)),
  seven_day: Schema.optional(Schema.NullOr(AnthropicBucket)),
  seven_day_opus: Schema.optional(Schema.NullOr(AnthropicBucket)),
  seven_day_sonnet: Schema.optional(Schema.NullOr(AnthropicBucket)),
})

const ChatGPTWindow = Schema.Struct({
  used_percent: Schema.optional(Schema.Finite),
  limit_window_seconds: Schema.optional(Schema.Finite),
  reset_at: Schema.optional(Schema.Finite),
})
const ChatGPTUsageResponse = Schema.Struct({
  rate_limit: Schema.optional(
    Schema.Struct({
      allowed: Schema.optional(Schema.Boolean),
      primary_window: Schema.optional(Schema.NullOr(ChatGPTWindow)),
      secondary_window: Schema.optional(Schema.NullOr(ChatGPTWindow)),
      tertiary_window: Schema.optional(Schema.NullOr(ChatGPTWindow)),
    }),
  ),
  additional_rate_limits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        limit_name: Schema.optional(Schema.String),
        rate_limit: Schema.optional(
          Schema.Struct({
            primary_window: Schema.optional(Schema.NullOr(ChatGPTWindow)),
            secondary_window: Schema.optional(Schema.NullOr(ChatGPTWindow)),
          }),
        ),
      }),
    ),
  ),
})

const SUBSCRIPTION_PROVIDERS = new Set(["google-antigravity", "anthropic", "openai"])

/** The usage of every available provider that configures a `usageURL` or has an active subscription connection. */
const readProviders = Effect.fn("UsageLimits.readProviders")(function* (
  providers: Provider.Interface,
  integrations: Integration.Interface,
  credentials: Credential.Interface,
  http: HttpClient.HttpClient,
) {
  const configured = (yield* providers.available()).filter(
    (provider) =>
      (typeof provider.settings?.usageURL === "string" && provider.settings.usageURL !== "") ||
      SUBSCRIPTION_PROVIDERS.has(provider.id),
  )
  return yield* Effect.forEach(
    configured,
    (provider) =>
      readProvider(http, integrations, credentials, provider).pipe(
        Effect.timeout(Duration.seconds(15)),
        Effect.orElseSucceed(() => undefined),
      ),
    { concurrency: 4 },
  ).pipe(Effect.map((usage) => usage.flatMap((entry) => (entry ? [entry] : []))))
})

const readProvider = Effect.fn("UsageLimits.readProvider")(function* (
  http: HttpClient.HttpClient,
  integrations: Integration.Interface,
  credentials: Credential.Interface,
  provider: Provider.Info,
) {
  const integrationID = provider.integrationID ?? Integration.ID.make(provider.id)
  const connection = yield* integrations.connection.active(integrationID)
  const credential = connection ? yield* integrations.connection.resolve(connection) : undefined
  const stored = connection
    ? undefined
    : (yield* credentials.list(integrationID)).flatMap((entry) => (entry.value.type === "key" ? [entry.value] : []))[0]

  if (credential && credential.type === "oauth") {
    if (provider.id === "google-antigravity" || String(integrationID) === "google-antigravity") {
      const project = typeof credential.metadata?.project === "string" ? credential.metadata.project : ""
      return yield* readAntigravityUsage(http, credential.access, project, provider)
    }
    if (provider.id === "anthropic" || String(integrationID) === "anthropic") {
      return yield* readAnthropicUsage(http, credential.access, provider)
    }
    if (provider.id === "openai" || String(integrationID) === "openai") {
      const accountID = typeof credential.metadata?.accountID === "string" ? credential.metadata.accountID : ""
      return yield* readChatGPTUsage(http, credential.access, accountID, provider)
    }
  }

  if (typeof provider.settings?.usageURL !== "string" || !provider.settings.usageURL) {
    return undefined
  }

  const token =
    credential && credential.type !== "external"
      ? credential.type === "oauth"
        ? credential.access
        : credential.key
      : typeof provider.settings?.apiKey === "string"
        ? provider.settings.apiKey
        : stored?.key
  const request = HttpClientRequest.get(provider.settings.usageURL).pipe(HttpClientRequest.acceptJson)
  const body = yield* HttpClient.withScope(http)
    .execute(token === undefined ? request : HttpClientRequest.bearerToken(token)(request))
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ProviderUsageResponse)),
      Effect.scoped,
    )
  return {
    providerID: Provider.ID.make(provider.id),
    ...(provider.name === provider.id ? {} : { name: provider.name }),
    windows:
      "windows" in body
        ? body.windows.map((window) => ({
            label: window.label ?? "",
            percent: Math.min(100, Math.max(0, window.percent)),
            limited: window.limited ?? false,
            ...(window.resetsAt === undefined
              ? window.resetsIn === undefined
                ? {}
                : { resetsAt: Date.now() + window.resetsIn }
              : {
                  resetsAt:
                    typeof window.resetsAt === "number" ? window.resetsAt : window.resetsAt.getTime(),
                }),
            ...(window.provider === undefined || window.provider === "" ? {} : { provider: window.provider }),
            ...(window.balance === undefined ? {} : { balance: Money.USD.make(window.balance) }),
          }))
        : [
            {
              label: "",
              // A drained credit balance blocks every model, and an unpurchased one never refills.
              percent: body.data.total_credits > 0 ? Math.min(100, (body.data.total_usage / body.data.total_credits) * 100) : 100,
              limited: body.data.total_credits <= body.data.total_usage,
              balance: Money.USD.make(Math.max(0, body.data.total_credits - body.data.total_usage)),
            },
          ],
  }
})

const readAntigravityUsage = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  token: string,
  project: string,
  provider: Provider.Info,
) {
  const url = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
  const request = yield* HttpClientRequest.post(url).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.setHeader("User-Agent", "antigravity/ide/2.5.5 (os_type=windows; arch=amd64; aidev_client; auth_method=oauth)"),
    HttpClientRequest.acceptJson,
    HttpClientRequest.bodyJson({ project }),
  )
  const body = yield* HttpClient.withScope(http)
    .execute(request)
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AntigravityQuotaResponse)),
      Effect.scoped,
    )
  const windows = (body.groups ?? []).flatMap((group) => {
    const groupName = group.displayName ?? "Models"
    return (group.buckets ?? []).flatMap((b) => {
      const target = b.remaining ?? b
      const remaining = target.remainingFraction ?? (target.remainingPercentage !== undefined ? target.remainingPercentage / 100 : undefined)
      if (remaining === undefined) return []
      const span = `${b.window ?? ""} ${b.bucketId ?? ""} ${b.displayName ?? ""}`.toLowerCase()
      const period = span.includes("week") ? "Weekly" : span.includes("5h") || span.includes("five") ? "5-hour" : ""
      const label = period ? `${groupName} · ${period}` : groupName
      const percent = Math.min(100, Math.max(0, Math.round((1 - remaining) * 100)))
      const resetsAt = b.resetTime ? Date.parse(b.resetTime) : undefined
      return [
        {
          label,
          percent,
          limited: remaining <= 0,
          ...(resetsAt && Number.isFinite(resetsAt) ? { resetsAt } : {}),
        },
      ]
    })
  })
  return {
    providerID: Provider.ID.make(provider.id),
    ...(provider.name === provider.id ? { name: "Google Antigravity" } : { name: provider.name }),
    windows,
  }
})

const readAnthropicUsage = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  token: string,
  provider: Provider.Info,
) {
  const url = "https://api.anthropic.com/api/oauth/usage"
  const request = HttpClientRequest.get(url).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.setHeader("User-Agent", "claude-cli/2.1.280 (external, cli)"),
    HttpClientRequest.acceptJson,
  )
  const body = yield* HttpClient.withScope(http)
    .execute(request)
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AnthropicUsageResponse)),
      Effect.scoped,
    )
  const bucket = (b: { utilization?: number; resets_at?: string } | null | undefined, label: string) => {
    if (!b || b.utilization === undefined) return []
    const percent = Math.min(100, Math.max(0, Math.round(b.utilization * 100)))
    const resetsAt = b.resets_at ? Date.parse(b.resets_at) : undefined
    return [
      {
        label,
        percent,
        limited: b.utilization >= 1,
        ...(resetsAt && Number.isFinite(resetsAt) ? { resetsAt } : {}),
      },
    ]
  }
  const windows = [
    ...bucket(body.five_hour, "5-hour"),
    ...bucket(body.seven_day, "Weekly"),
    ...bucket(body.seven_day_opus, "Weekly · Opus"),
    ...bucket(body.seven_day_sonnet, "Weekly · Sonnet"),
  ]
  const result: UsageLimits.ProviderUsage = {
    providerID: Provider.ID.make(provider.id),
    ...(provider.name === provider.id ? { name: "Claude Subscription" } : { name: provider.name }),
    windows,
  }
  return result
})

const readChatGPTUsage = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  token: string,
  accountID: string,
  provider: Provider.Info,
) {
  const url = "https://chatgpt.com/backend-api/wham/usage"
  const request = HttpClientRequest.get(url).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.setHeader("chatgpt-account-id", accountID),
    HttpClientRequest.acceptJson,
  )
  const body = yield* HttpClient.withScope(http)
    .execute(request)
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ChatGPTUsageResponse)),
      Effect.scoped,
    )
  const limits = body.rate_limit
  const allowed = limits?.allowed !== false
  const windowOf = (w: { used_percent?: number; reset_at?: number } | null | undefined, label: string) => {
    if (!w || w.used_percent === undefined) return []
    const percent = Math.min(100, Math.max(0, Math.round(w.used_percent)))
    const resetsAt = w.reset_at ? w.reset_at * 1000 : undefined
    return [
      {
        label,
        percent,
        limited: !allowed || percent >= 100,
        ...(resetsAt && Number.isFinite(resetsAt) ? { resetsAt } : {}),
      },
    ]
  }
  const windows = [
    ...windowOf(limits?.primary_window, "5-hour"),
    ...windowOf(limits?.secondary_window, "Weekly"),
    ...windowOf(limits?.tertiary_window, "Monthly"),
  ]
  for (const extra of body.additional_rate_limits ?? []) {
    const name = extra.limit_name ? `${extra.limit_name} · ` : ""
    windows.push(
      ...windowOf(extra.rate_limit?.primary_window, `${name}5-hour`),
      ...windowOf(extra.rate_limit?.secondary_window, `${name}Weekly`),
    )
  }
  return {
    providerID: Provider.ID.make(provider.id),
    ...(provider.name === provider.id ? { name: "ChatGPT Subscription" } : { name: provider.name }),
    windows,
  }
})

// One budget as `GET /api/policies/current-budgets` describes it.
const ConsoleBudget = Schema.Struct({
  ruleID: Schema.String,
  limitDollars: Schema.Finite,
  spentDollars: Schema.Finite,
  scope: UsageLimits.Budget.fields.scope,
  per: UsageLimits.Budget.fields.per,
  coverage: UsageLimits.Budget.fields.coverage,
  models: Schema.Array(
    Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
      name: Schema.String,
      spentDollars: Schema.optional(Schema.Finite),
    }),
  ),
  vendors: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  inputPriceAtLeast: Schema.optional(Schema.Finite),
  picked: Schema.Boolean,
  shared: Schema.Boolean,
  resetsAt: Schema.DateFromString,
})

const GoMeter = Schema.Struct({
  status: Schema.Literals(["ok", "rate-limited"]),
  percent: Schema.Finite,
  resetsAt: Schema.DateFromString,
})
const GoUsage = Schema.Struct({ usage: Schema.Struct({ rolling: GoMeter, weekly: GoMeter, monthly: GoMeter }) })

/** Every budget covering the member. Console refuses a service account's key with 403, and it has no budgets. */
function readBudgets(http: HttpClient.HttpClient, server: string, credential: Credential.Key | Credential.OAuth) {
  return HttpClient.withScope(http)
    .execute(
      HttpClientRequest.get(`${server}/api/policies/current-budgets`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeaders(ConsoleAccess.headers(credential)),
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        response.status === 403
          ? Effect.succeed([])
          : HttpClientResponse.filterStatusOk(response).pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Array(ConsoleBudget))),
              Effect.map((budgets) =>
                budgets.map((budget) => ({
                  id: budget.ruleID,
                  limit: Money.USD.make(budget.limitDollars),
                  spent: Money.USD.make(budget.spentDollars),
                  scope: budget.scope,
                  per: budget.per,
                  coverage: budget.coverage,
                  models: budget.models.map((model) => ({
                    providerID: Provider.ID.make(model.providerID),
                    modelID: Model.ID.make(model.modelID),
                    name: model.name,
                    ...(model.spentDollars === undefined ? {} : { spent: Money.USD.make(model.spentDollars) }),
                  })),
                  vendors: budget.vendors.map((vendor) => vendor.name),
                  ...(budget.inputPriceAtLeast === undefined
                    ? {}
                    : { inputPriceAtLeast: Money.USDPerMillionTokens.make(budget.inputPriceAtLeast) }),
                  picked: budget.picked,
                  shared: budget.shared,
                  resetsAt: budget.resetsAt.getTime(),
                })),
              ),
            ),
      ),
      Effect.scoped,
      Effect.mapError(
        (error) => new UnavailableError({ message: `OpenCode Console budgets are unavailable: ${error.message}` }),
      ),
    )
}

/**
 * The Go allowance, from the inference API that shares the Console's origin. Go refuses (403) a workspace the member
 * doesn't subscribe to Go in, which has no allowance to show.
 */
function readGo(
  http: HttpClient.HttpClient,
  server: string,
  credential: Credential.Key | Credential.OAuth,
  workspaceID: string,
) {
  return HttpClient.withScope(http)
    .execute(
      HttpClientRequest.get(`${new URL(server).origin}/zen/go/v1/usage`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(credential.type === "oauth" ? credential.access : credential.key),
        HttpClientRequest.setHeader("x-opencode-org-id", workspaceID),
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        response.status === 403
          ? Effect.succeed(undefined)
          : HttpClientResponse.filterStatusOk(response).pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(GoUsage)),
              Effect.map((body) => ({
                rolling: meter(body.usage.rolling),
                weekly: meter(body.usage.weekly),
                monthly: meter(body.usage.monthly),
              })),
            ),
      ),
      Effect.scoped,
      Effect.mapError(
        (error) => new UnavailableError({ message: `OpenCode Go usage is unavailable: ${error.message}` }),
      ),
    )
}

function meter(value: typeof GoMeter.Type) {
  return { percent: value.percent, limited: value.status === "rate-limited", resetsAt: value.resetsAt.getTime() }
}
