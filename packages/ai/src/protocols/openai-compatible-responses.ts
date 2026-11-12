import { Effect, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { Endpoint } from "../route/endpoint.js"
import { Route } from "../route/client.js"
import { Protocol } from "../route/protocol.js"
import { HttpTransport } from "../route/transport/index.js"
import type { LLMRequest, ToolDefinition } from "../schema/index.js"
import { OpenResponses } from "./open-responses.js"
import { JsonObject, optionalNull, ProviderShared } from "./shared.js"
import { ResponsesHostedTools } from "./utils/responses-hosted-tools.js"
import { detectMediaType } from "../utils/media-type.js"

const ADAPTER = "openai-compatible-responses"
const NAME = "OpenAI Compatible Responses"

/**
 * Deployment adapter for providers that expose an OpenAI Responses-compatible
 * `/responses` endpoint. Provider helpers configure identity, endpoint, and
 * auth while the semantic protocol stays the provider-neutral Open Responses
 * baseline, extended with the hosted `image_generation` tool vocabulary that
 * OpenAI-compatible gateways forward to the upstream image model.
 */
const ImageGenerationTool = Schema.Struct({
  type: Schema.tag("image_generation"),
  action: optionalNull(Schema.Literals(["auto", "generate", "edit"])),
  background: optionalNull(Schema.Literals(["auto", "opaque", "transparent"])),
  input_fidelity: optionalNull(Schema.Literals(["low", "high"])),
  output_compression: optionalNull(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  output_format: optionalNull(Schema.Literals(["png", "jpeg", "webp"])),
  partial_images: optionalNull(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  quality: optionalNull(Schema.Literals(["auto", "low", "medium", "high"])),
  size: optionalNull(
    Schema.String.check(
      Schema.makeFilter((value) => {
        if (value === "auto") return undefined
        const match = /^(\d+)x(\d+)$/.exec(value)
        if (!match) return "image size must be `auto` or `{width}x{height}`"
        return Number(match[1]) > 0 && Number(match[2]) > 0 ? undefined : "image dimensions must be positive integers"
      }),
    ),
  ),
})

const HostedToolItem = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.tag("image_generation_call"),
    id: Schema.String,
    status: Schema.optional(Schema.String),
    result: optionalNull(Schema.String),
    output_format: optionalNull(Schema.Literals(["png", "jpeg", "webp"])),
    revised_prompt: optionalNull(Schema.String),
    error: optionalNull(Schema.Unknown),
  }),
  [JsonObject],
)

const Body = Schema.Struct({
  ...OpenResponses.OpenResponsesBody.fields,
  // The baseline `tools` already accept open hosted entries; only the forced choice by tool type is added.
  tool_choice: Schema.optional(
    Schema.Union([OpenResponses.ToolChoice, Schema.Struct({ type: Schema.tag("image_generation") })]),
  ),
})

const adapter = {
  id: ADAPTER,
  name: NAME,
  // The hosted tool definition is OpenAI's; `OpenAI.imageGeneration` keys it under `openai`.
  nativeTool: (native: NonNullable<ToolDefinition["native"]>) =>
    ProviderShared.validateWith(Schema.decodeUnknownEffect(ImageGenerationTool))(native.openai),
  restoreHostedToolItem: (item: unknown) => (Schema.is(HostedToolItem)(item) ? item : undefined),
} satisfies OpenResponses.ProviderAdapter

const nativeImageTool = (tool: ToolDefinition) =>
  ProviderShared.isRecord(tool.native?.openai) && tool.native.openai.type === "image_generation" ? tool : undefined

const fromRequest = Effect.fn("OpenAICompatibleResponses.fromRequest")(function* (request: LLMRequest) {
  const body = yield* OpenResponses.fromRequestWithAdapter(request, adapter)
  // The baseline names a forced choice as a function tool; hosted tools are chosen by their type instead.
  const forced = request.toolChoice?.type === "tool" ? request.toolChoice.name : undefined
  const hosted =
    forced !== undefined &&
    ProviderShared.flattenTools(request.tools).some((tool) => tool.name === forced && nativeImageTool(tool) !== undefined)
  return hosted ? { ...body, tool_choice: { type: "image_generation" as const } } : body
})

const hostedImageResult = Effect.fnUntraced(function* (item: ResponsesHostedTools.Item) {
  if (item.result === undefined || item.result === null) {
    if (item.error !== undefined && item.error !== null) return { type: "error" as const, value: item.error }
    return yield* ProviderShared.eventError(
      ADAPTER,
      `${NAME} returned an image without data`,
      ProviderShared.encodeJson(item),
    )
  }
  const data = yield* Effect.fromResult(Base64.decode(item.result)).pipe(
    Effect.mapError((cause) =>
      ProviderShared.eventError(ADAPTER, `${NAME} returned invalid image base64`, ProviderShared.encodeJson(item), cause),
    ),
  )
  const format = item.output_format ?? undefined
  const mime =
    format !== undefined ? `image/${format}` : (detectMediaType(data) ?? "application/octet-stream")
  return {
    type: "content" as const,
    value: [{ type: "file" as const, uri: `data:${mime};base64,${item.result}`, mime }],
  }
})

const HOSTED_TOOLS = {
  // Only the hosted image tool is interpreted; other hosted item types keep the baseline's opaque passthrough.
  image_generation_call: { name: "image_generation", input: () => ({}), result: hostedImageResult },
} as const satisfies ResponsesHostedTools.Definitions

export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: Body,
    from: fromRequest,
  },
  stream: ResponsesHostedTools.stream(adapter, HOSTED_TOOLS),
})

/**
 * Deployment route for providers that expose an OpenAI Responses-compatible
 * `/responses` endpoint. Provider helpers configure identity, endpoint, and
 * auth while the semantic protocol stays the provider-neutral Open Responses
 * baseline, extended with the hosted `image_generation` tool vocabulary that
 * OpenAI-compatible gateways forward to the upstream image model.
 */
export const route = Route.make({
  id: ADAPTER,
  providerMetadataKey: "openresponses",
  protocol,
  endpoint: Endpoint.path(OpenResponses.PATH),
  transport: HttpTransport.sseJson.with<Schema.Schema.Type<typeof Body>>(),
  defaults: { providerOptions: { store: false, include: ["reasoning.encrypted_content"] } },
})

export * as OpenAICompatibleResponses from "./openai-compatible-responses.js"
