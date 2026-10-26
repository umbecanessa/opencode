import { fetch as streamingFetch } from "expo/fetch"
import type { FileContent, FileEntry, Host, MessagePage, PermissionRequest, Session, SessionEvent } from "./types"

export type Location = { directory: string }

const loc = (l: Location) => `location=${encodeURIComponent(JSON.stringify(l))}`

export class Client {
  constructor(
    private host: Host,
    private token: string,
  ) {}

  private headers = (accept = "application/json") => ({
    accept,
    authorization: `Bearer ${this.token}`,
  })

  private async request<T>(path: string, init?: { method?: string; body?: string }): Promise<T> {
    const res = await fetch(`${this.host.origin}${path}`, {
      method: init?.method ?? "GET",
      body: init?.body,
      headers: this.headers(),
    })
    if (res.status === 401) throw new Error(`${this.host.name}: pairing expired — re-pair this host`)
    if (!res.ok) throw new Error(`${this.host.name}: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300))
    return (await res.json()) as T
  }

  info = () => this.request<{ version: string; capabilities?: Record<string, boolean> }>("/api/info")

  projects = () => this.request<{ id: string; name?: string; canonical?: string }[]>("/api/project")

  sessions = (query: string) =>
    this.request<{ data: unknown[]; cursor?: { next: string | null } }>(`/api/session?${query}`)

  active = () => this.request<{ data: Record<string, { type: string }> }>("/api/session/active")

  session = (id: string) => this.request<{ id: string; title?: string; location?: { directory: string } }>(`/api/session/${id}`)

  messages = (sessionID: string, cursor?: string) =>
    this.request<{ data: Record<string, unknown>[]; cursor: MessagePage["cursor"] }>(
      `/api/session/${sessionID}/message?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    ).then((r) => ({ ...r, host: this.host.id, sessionID }))

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

  permissionRequests = () => this.request<{ data: PermissionRequest[] }>("/api/permission/request")

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
