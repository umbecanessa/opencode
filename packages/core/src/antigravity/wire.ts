import crypto from "node:crypto"

export type Item = Record<string, unknown>

export function asItem(value: unknown): Item | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Item) : null
}

export function num(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() ? Number(value) : value
  return typeof n === "number" && Number.isFinite(n) ? n : undefined
}

export function toEpochMs(value: unknown): number | null {
  if (typeof value === "string" && value && Number.isNaN(Number(value))) {
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : null
  }
  const n = num(value)
  if (n === undefined || n <= 0) return null
  return n < 10_000_000_000 ? n * 1000 : n
}

export function clampPercent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10))
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      const p = part as Item
      return typeof p.text === "string" ? p.text : ""
    })
    .filter(Boolean)
    .join("\n")
}

const SIGNATURE_SENTINEL = "skip_thought_signature_validator"
const MAX_SIGNATURES = 2000
const signatures = new Map<string, string>()

export function rememberSignature(callId: string, signature: unknown): void {
  if (typeof signature !== "string" || signature.length < 16) return
  signatures.set(callId, signature)
  if (signatures.size > MAX_SIGNATURES) signatures.delete(signatures.keys().next().value as string)
}

const SCHEMA_KEYS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
  "nullable",
  "anyOf",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "title",
])

export function geminiSchema(schema: unknown): Item {
  const src = asItem(schema)
  if (!src) return { type: "object", properties: {} }
  const out: Item = {}
  for (const [key, value] of Object.entries(src)) {
    if (key === "const") out.enum = [value]
    else if (!SCHEMA_KEYS.has(key)) continue
    else if (key === "type" && Array.isArray(value)) {
      const types = (value as string[]).filter((t) => t !== "null")
      out.type = types[0] ?? "string"
      if (types.length < (value as string[]).length) out.nullable = true
    } else if (key === "properties") {
      out.properties = Object.fromEntries(Object.entries(asItem(value) ?? {}).map(([k, v]) => [k, geminiSchema(v)]))
    } else if (key === "items") {
      out.items = geminiSchema(value)
    } else if (key === "anyOf" && Array.isArray(value)) {
      out.anyOf = value.map(geminiSchema)
    } else if (key === "enum" && Array.isArray(value)) {
      out.enum = value.map(String)
    } else {
      out[key] = value
    }
  }
  if (out.enum && !out.type) out.type = "string"
  if (Array.isArray(out.required) && asItem(out.properties)) {
    out.required = (out.required as string[]).filter((r) => r in (out.properties as Item))
  }
  return out
}

function userParts(content: unknown): Item[] {
  if (typeof content === "string") return content ? [{ text: content }] : []
  if (!Array.isArray(content)) return []
  const parts: Item[] = []
  for (const raw of content as Item[]) {
    if (raw.type === "text" && typeof raw.text === "string") parts.push({ text: raw.text })
    else if (raw.type === "image_url") {
      const image = raw.image_url as Item | string
      const url = typeof image === "string" ? image : image?.url
      const data = typeof url === "string" ? /^data:([^;]+);base64,(.+)$/.exec(url) : null
      if (data) parts.push({ inlineData: { mimeType: data[1], data: data[2] } })
    }
  }
  return parts
}

function parseArguments(raw: unknown): Item {
  if (typeof raw !== "string") return asItem(raw) ?? {}
  try {
    return asItem(JSON.parse(raw)) ?? {}
  } catch {
    return {}
  }
}

function chatTools(body: { tools?: unknown }): Array<{ name: string; description?: string; parameters: Item }> {
  if (!Array.isArray(body.tools)) return []
  return (body.tools as Item[])
    .map((tool) => (tool.function ?? tool) as Item)
    .filter((fn) => typeof fn.name === "string")
    .map((fn) => ({
      name: fn.name as string,
      description: typeof fn.description === "string" ? fn.description : undefined,
      parameters: (asItem(fn.parameters) ?? { type: "object", properties: {} }) as Item,
    }))
}

export function chatToGemini(body: Record<string, unknown>, opts: { signatureFallback: boolean }): Item {
  const system: string[] = []
  const contents: Array<{ role: "user" | "model"; parts: Item[] }> = []
  const callNames = new Map<string, string>()
  const push = (role: "user" | "model", parts: Item[]) => {
    if (!parts.length) return
    const last = contents.at(-1)
    if (last?.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }
  const messages = (Array.isArray(body.messages) ? body.messages : []) as Item[]
  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = textOf(msg.content)
      if (text) system.push(text)
    } else if (msg.role === "user") {
      push("user", userParts(msg.content))
    } else if (msg.role === "assistant") {
      const text = textOf(msg.content)
      const parts: Item[] = text ? [{ text }] : []
      for (const call of (msg.tool_calls as Item[] | undefined) ?? []) {
        const fn = (call.function ?? {}) as Item
        const id = String(call.id ?? "")
        callNames.set(id, String(fn.name))
        const part: Item = { functionCall: { name: fn.name, args: parseArguments(fn.arguments) } }
        const signature = signatures.get(id)
        if (signature) part.thoughtSignature = signature
        parts.push(part)
      }
      push("model", parts)
    } else if (msg.role === "tool") {
      const id = String(msg.tool_call_id ?? "")
      push("user", [{ functionResponse: { name: callNames.get(id) ?? "tool", response: { output: textOf(msg.content) } } }])
    }
  }
  if (opts.signatureFallback) {
    for (const content of contents) {
      if (content.role !== "model") continue
      const first = content.parts.find((p) => p.functionCall)
      if (first && !first.thoughtSignature) first.thoughtSignature = SIGNATURE_SENTINEL
    }
  }

  const request: Item = { contents }
  if (system.length) request.systemInstruction = { role: "user", parts: [{ text: system.join("\n\n") }] }
  const tools = chatTools(body)
  if (tools.length) {
    request.tools = [
      { functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description ?? "", parameters: geminiSchema(t.parameters) })) },
    ]
    const choice = body.tool_choice as Item | string | undefined
    const mode = choice === "required" ? "ANY" : choice === "none" ? "NONE" : choice && typeof choice === "object" ? "ANY" : "AUTO"
    const config: Item = { mode }
    if (choice && typeof choice === "object") config.allowedFunctionNames = [(choice.function as Item | undefined)?.name]
    request.toolConfig = { functionCallingConfig: config }
  }
  const generationConfig: Item = {}
  const maxTokens = body.max_completion_tokens ?? body.max_tokens
  if (typeof maxTokens === "number") generationConfig.maxOutputTokens = maxTokens
  if (typeof body.temperature === "number") generationConfig.temperature = body.temperature
  if (typeof body.top_p === "number") generationConfig.topP = body.top_p
  if (body.stop) generationConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop]
  if (typeof body.reasoning_effort === "string" && ["low", "medium", "high"].includes(body.reasoning_effort)) {
    generationConfig.thinkingConfig = { thinkingLevel: body.reasoning_effort }
  }
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig
  return request
}

export function geminiSessionId(body: Record<string, unknown>): string {
  const messages = (Array.isArray(body.messages) ? body.messages : []) as Item[]
  const first = messages.find((m) => m.role === "user")
  const text = first ? textOf(first.content) : ""
  if (!text) return `-${crypto.randomInt(1, 2 ** 47)}`
  const digest = crypto.createHash("sha256").update(text, "utf8").digest()
  return `-${(digest.readBigUInt64BE(0) & 0x7fffffffffffffffn).toString()}`
}

const FINISH: Record<string, string> = { STOP: "stop", MAX_TOKENS: "length", SAFETY: "content_filter", RECITATION: "content_filter" }

interface GeminiChunk {
  parts: Item[]
  finishReason: string | null
  usage: Item | null
}

function chunkOf(data: Item): GeminiChunk {
  const response = asItem(data.response) ?? data
  const candidate = asItem((response.candidates as unknown[] | undefined)?.[0])
  return {
    parts: ((asItem(candidate?.content)?.parts as Item[] | undefined) ?? []).filter(Boolean),
    finishReason: typeof candidate?.finishReason === "string" ? candidate.finishReason : null,
    usage: asItem(response.usageMetadata),
  }
}

function chatUsage(input: number | undefined, output: number | undefined, cached = 0): Item | undefined {
  if (input === undefined && output === undefined) return undefined
  const i = input ?? 0
  const o = output ?? 0
  return { prompt_tokens: i, completion_tokens: o, total_tokens: i + o, prompt_tokens_details: { cached_tokens: cached } }
}

function geminiUsage(usage: Item | null): Item | undefined {
  if (!usage) return undefined
  const output = Number(usage.candidatesTokenCount ?? 0) + Number(usage.thoughtsTokenCount ?? 0)
  return chatUsage(Number(usage.promptTokenCount ?? 0), output, Number(usage.cachedContentTokenCount ?? 0))
}

function newCallId(part: Item): string {
  const fn = asItem(part.functionCall)
  const id = typeof fn?.id === "string" && fn.id ? fn.id : `call_${crypto.randomBytes(9).toString("hex")}`
  rememberSignature(id, part.thoughtSignature ?? part.thought_signature)
  return id
}

export interface SseEvent {
  event: string
  data: Item
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder()
  let buffer = ""
  const reader = body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
      let cut: number
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        let event = ""
        const data: string[] = []
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim()
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
        }
        const payload = data.join("\n")
        if (!payload || payload === "[DONE]") continue
        try {
          const parsed = JSON.parse(payload) as Item
          yield { event: event || String(parsed.type ?? ""), data: parsed }
        } catch {
          // ignore invalid partial JSON
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function chunkWriter(model: string) {
  const encoder = new TextEncoder()
  const id = `chatcmpl-${crypto.randomBytes(8).toString("hex")}`
  const created = Math.floor(Date.now() / 1000)
  return {
    delta: (delta: Item, finish: string | null = null) =>
      encoder.encode(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      ),
    usage: (usage: Item) =>
      encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`),
    error: (message: string) => encoder.encode(`data: ${JSON.stringify({ error: { message, type: "upstream_error" } })}\n\n`),
    done: () => encoder.encode("data: [DONE]\n\n"),
  }
}

export function geminiStreamToChat(upstream: ReadableStream<Uint8Array>, model: string, includeUsage: boolean): ReadableStream<Uint8Array> {
  const w = chunkWriter(model)
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let toolCount = 0
      let finish: string | null = null
      let usage: Item | null = null
      controller.enqueue(w.delta({ role: "assistant", content: "" }))
      try {
        for await (const ev of readSse(upstream)) {
          if (asItem(ev.data.error)) {
            controller.enqueue(w.error(String(asItem(ev.data.error)?.message ?? "Gemini returned an error")))
            break
          }
          const chunk = chunkOf(ev.data)
          for (const part of chunk.parts) {
            const fn = asItem(part.functionCall)
            if (fn) {
              controller.enqueue(
                w.delta({
                  tool_calls: [{ index: toolCount++, id: newCallId(part), type: "function", function: { name: fn.name, arguments: JSON.stringify(fn.args ?? {}) } }],
                }),
              )
            } else if (typeof part.text === "string" && part.text) {
              controller.enqueue(w.delta(part.thought === true ? { reasoning_content: part.text } : { content: part.text }))
            }
          }
          if (chunk.usage) usage = chunk.usage
          if (chunk.finishReason) finish = chunk.finishReason
        }
        controller.enqueue(w.delta({}, toolCount ? "tool_calls" : (FINISH[finish ?? "STOP"] ?? "stop")))
        const u = geminiUsage(usage)
        if (includeUsage && u) controller.enqueue(w.usage(u))
      } catch (err) {
        controller.enqueue(w.error(err instanceof Error ? err.message : String(err)))
      }
      controller.enqueue(w.done())
      controller.close()
    },
  })
}
