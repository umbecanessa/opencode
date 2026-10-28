import { fetch as streamingFetch } from "expo/fetch"
import type {
  FileContent,
  FileEntry,
  Host,
  MessagePage,
  PermissionDecision,
  PermissionRequest,
  Session,
  SessionEvent,
} from "./types"

export type Location = { directory: string }

const loc = (l: Location) => `location[directory]=${encodeURIComponent(l.directory)}`

export class Client {
  constructor(
    private host: Host,
    private token: string,
  ) {}

  // Server auth is HTTP Basic with the fixed user "opencode"; the paired session
  // token is used as the password (see packages/app/src/runtime/server/api.ts).
  private headers = (accept = "application/json") => ({
    accept,
    authorization: `Basic ${btoa(`opencode:${this.token}`)}`,
  })

  private async request<T>(path: string, init?: { method?: string; body?: string }): Promise<T> {
    const res = await fetch(`${this.host.origin}${path}`, {
      method: init?.method ?? "GET",
      body: init?.body,
      headers: init?.body ? { ...this.headers(), "content-type": "application/json" } : this.headers(),
    })
    if (res.status === 401) throw new Error(`${this.host.name}: pairing expired — re-pair this host`)
    if (!res.ok) throw new Error(`${this.host.name}: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300))
    return (await res.json()) as T
  }

  info = () => this.request<{ version: string; capabilities?: Record<string, boolean> }>("/api/info")

  models = (directory: string) => this.request<{ data: { id: string; modelID: string; providerID: string; name: string; limit?: { context: number }; variants: { id: string }[] }[] }>(`/api/model?${loc({ directory })}`)
  context = (id: string) => this.request<{ data: unknown[] }>(`/api/session/${id}/context`)
  diff = (id: string) => this.request<{ data: { file: string; patch: string; additions: number; deletions: number; status: "added" | "deleted" | "modified" }[] }>(`/api/session/${id}/diff?context=3`)
  permissions = (id: string) => this.request<{ permissions?: { action: string; resource: string; effect: "allow" | "deny" | "ask" }[] }>(`/api/session/${id}`)
  setPermissions = async (id: string, permissions: { action: string; resource: string; effect: "allow" | "deny" | "ask" }[]) => {
    const res = await fetch(`${this.host.origin}/api/session/${id}`, {
      method: "PATCH", headers: { ...this.headers(), "content-type": "application/json" }, body: JSON.stringify({ permissions }),
    })
    if (!res.ok) throw new Error(`Could not update permissions (${res.status})`)
  }
  switchModel = async (id: string, model: { providerID: string; modelID: string; variant?: string }) => {
    const res = await fetch(`${this.host.origin}/api/session/${id}/model`, {
      method: "POST", headers: { ...this.headers(), "content-type": "application/json" }, body: JSON.stringify({ model: { id: model.modelID, providerID: model.providerID, ...(model.variant ? { variant: model.variant } : {}) } }),
    })
    if (!res.ok) throw new Error(`Could not switch model (${res.status})`)
  }

  projects = () => this.request<{ id: string; name?: string; canonical?: string }[]>("/api/project")

  sessions = (query: string) =>
    this.request<{ data: unknown[]; cursor?: { next: string | null } }>(`/api/session?${query}`)

  active = () => this.request<{ data: Record<string, { type: string }> }>("/api/session/active")

  session = (id: string) => this.request<{ id: string; title?: string; model?: { id: string; providerID: string; variant?: string }; cost?: number; time?: { created: number; updated: number }; location?: { directory: string } }>(`/api/session/${id}`)

  messages = (sessionID: string, cursor?: string) =>
    this.request<{ data: Record<string, unknown>[]; cursor: MessagePage["cursor"] }>(
      `/api/session/${sessionID}/message?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    ).then((r) => ({ ...r, host: this.host.id, sessionID }))

  prompt = (sessionID: string, text: string, files?: { uri: string; name?: string }[]) =>
    this.request<{ data: { id: string; time?: { created?: number }; type?: string; payload?: { text?: string } } }>(
      `/api/session/${sessionID}/prompt`,
      { method: "POST", body: JSON.stringify(files?.length ? { text, files } : { text }) },
    )

  interrupt = (sessionID: string) =>
    this.request<{ interrupted: boolean }>(`/api/session/${sessionID}/interrupt`, { method: "POST" })

  background = async (sessionID: string) => {
    const res = await fetch(`${this.host.origin}/api/session/${sessionID}/background`, {
      method: "POST",
      headers: this.headers(),
    })
    if (!res.ok) throw new Error(`Could not background tools (${res.status})`)
  }

  fsList = (l: Location, path: string) =>
    this.request<{ data: FileEntry[] }>(`/api/fs/list?${loc(l)}&path=${encodeURIComponent(path)}`)

  fsRead = async (l: Location, path: string, limit = 2_000_000): Promise<FileContent> => {
    const url = `${this.host.origin}/api/fs/read/${encodeURIComponent(path)}?${loc(l)}`
    const res = await fetch(url, { headers: this.headers("application/octet-stream") })
    if (res.status === 401) throw new Error(`${this.host.name}: pairing expired — re-pair this host`)
    if (!res.ok) throw new Error(`Cannot read ${path} on ${this.host.name} (${res.status})`)
    const size = Number(res.headers.get("content-length") ?? 0)
    if (size > limit) throw new Error(`File is larger than ${(limit / 1e6).toFixed(0)} MB on ${this.host.name}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const truncated = bytes.length > limit
    const slice = truncated ? bytes.slice(0, limit) : bytes
    if (slice.includes(0)) throw new Error(`${path} is a binary file on ${this.host.name}`)
    const decoder = new TextDecoder("utf-8", { fatal: false })
    return { text: decoder.decode(slice), truncated, size: size || bytes.length }
  }

  // The global /api/permission/request list is scoped to one location; the per-session list is not.
  sessionPermissions = (sessionID: string) =>
    this.request<{ data: Omit<PermissionRequest, "host">[] }>(`/api/session/${sessionID}/permission`).then((r) =>
      r.data.map((p) => ({ ...p, host: this.host.id }) satisfies PermissionRequest),
    )

  replyPermission = async (sessionID: string, requestID: string, decision: PermissionDecision) => {
    const res = await fetch(`${this.host.origin}/api/session/${sessionID}/permission/${requestID}/reply`, {
      method: "POST",
      body: JSON.stringify({ decision }),
      headers: { ...this.headers(), "content-type": "application/json" },
    })
    if (res.status === 401) throw new Error(`${this.host.name}: pairing expired — re-pair this host`)
    if (!res.ok) throw new Error(`${this.host.name}: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300))
  }

  children = (parentID: string) =>
    this.sessions(`parentID=${encodeURIComponent(parentID)}&limit=50&order=desc`).then((r) =>
      r.data.map((raw) => ({ ...(raw as object), host: this.host.id }) as Session),
    )

  events = (onEvent: (e: SessionEvent) => void, signal: AbortSignal) =>
    (async () => {
      while (!signal.aborted) {
        try {
          const res = await streamingFetch(`${this.host.origin}/api/event`, {
            headers: this.headers("text/event-stream"),
            signal: signal as never,
          })
          if (!res.ok || !res.body) throw new Error(`event stream: ${res.status}`)
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let cut = buffer.indexOf("\n\n")
            while (cut >= 0) {
              const frame = buffer.slice(0, cut)
              buffer = buffer.slice(cut + 2)
              cut = buffer.indexOf("\n\n")
              for (const line of frame.split("\n")) {
                if (!line.startsWith("data:")) continue
                try {
                  const parsed = JSON.parse(line.slice(5))
                  const type = (parsed.type ?? parsed.event) as string
                  if (type) onEvent({ host: this.host.id, type, data: parsed.data ?? {} })
                } catch {}
              }
            }
          }
        } catch {
          if (signal.aborted) return
        }
        await new Promise((r) => setTimeout(r, 3000))
      }
    })()

  static redeem = (link: string) =>
    fetch(link, { headers: { accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Pairing link failed (${res.status}). Is the host awake and on Tailscale?`)
        return (await res.json()) as { token: string }
      })
      .then((r) => {
        const url = new URL(link)
        return { origin: `${url.protocol}//${url.host}`, token: r.token }
      })
}

export const decodeSession = (host: string) => (raw: Record<string, unknown>) =>
  ({
    ...(raw as object),
    id: raw.id as string,
    projectID: raw.projectID as string,
    title: (raw.title as string) || "Untitled session",
    location: raw.location as Location,
    time: raw.time as Session["time"],
    cost: (raw.cost as number) ?? 0,
    tokens: (raw.tokens as Session["tokens"]) ?? { input: 0, output: 0, reasoning: 0 },
    host,
  }) satisfies Session
