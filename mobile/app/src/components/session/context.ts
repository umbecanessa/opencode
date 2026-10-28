import type { Message } from "./Timeline"

export type ContextMessage = Message & {
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  model?: { id?: string; providerID?: string }
}

// Desktop context usage is the latest assistant step's usage, not cumulative session tokens.
export function contextUsage(messages: ContextMessage[]) {
  const latest = messages.filter((m) => m.type === "assistant" && m.tokens)
    .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))[0]
  const tokens = latest?.tokens
  const total = tokens ? tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write : undefined
  return { latest, tokens, total }
}
