import { fetch as streamingFetch } from "expo/fetch"
import { cachedLanOrigin, findLanOrigin, forgetLanOrigin } from "./lan"
import type {
  FileContent,
  FileEntry,
  Host,
  MessagePage,
  PermissionDecision,
  PermissionRequest,
  Session,
  SessionEvent,
  SessionForm,
  FormValue,
  VoicePendingCard,
} from "./types"

export type Location = { directory: string }

const loc = (l: Location) => new URLSearchParams({ "location[directory]": l.directory }).toString()

export class Client {
  // When the tailnet path fails, a verified LAN origin (same Wi-Fi) takes over until it too dies.
  private lanOrigin?: string
  private lanProbe?: Promise<string | undefined>

  constructor(
    private host: Host,
    private token: string,
  ) {
    void cachedLanOrigin(host.id).then((origin) => {
      if (origin) this.lanOrigin = origin
    })
  }

  private base = () => this.lanOrigin ?? this.host.origin

  // Server auth is HTTP Basic with the fixed user "opencode"; the paired session
  // token is used as the password (see packages/app/src/runtime/server/api.ts).
  private headers = (accept = "application/json") => ({
    accept,
    authorization: `Basic ${btoa(`opencode:${this.token}`)}`,
  })

  // One transport for every call: prefers the cached LAN origin, and on a connection-class failure
  // (timeout/DNS/refused — not an HTTP status) sweeps the local subnet once before giving up.
  // Byte bodies (voice uploads) ride expo/fetch, whose normalizeBodyInit accepts typed arrays;
  // the default RN fetch is kept for string bodies to avoid changing behavior elsewhere.
  private send(
    path: string,
    init?: { method?: string; body?: string | Uint8Array; timeout?: number; accept?: string; contentType?: string },
  ) {
    const fetchVia = (origin: string) =>
      (typeof init?.body === "string" || init?.body === undefined ? fetch : streamingFetch)(`${origin}${path}`, {
        method: init?.method ?? "GET",
        body: init?.body as never,
        headers: init?.body
          ? { ...this.headers(init?.accept), "content-type": init?.contentType ?? "application/json" }
          : this.headers(init?.accept),
        ...(init?.timeout !== undefined ? { signal: AbortSignal.timeout(init.timeout) } : {}),
      })
    return fetchVia(this.base()).catch(async (error) => {
      if (this.lanOrigin) {
        // The remembered LAN path went stale (phone moved networks): drop it and use the paired origin.
        void forgetLanOrigin(this.host.id)
        this.lanOrigin = undefined
        throw error
      }
      this.lanProbe ??= findLanOrigin(this.host.id, this.host.origin, this.token)
      const lan = await this.lanProbe
      this.lanProbe = undefined
      if (!lan) throw error
      this.lanOrigin = lan
      console.warn(`[lan] ${this.host.name}: falling back to ${lan}`)
      return fetchVia(lan)
    })
  }

  private async request<T>(path: string, init?: { method?: string; body?: string }): Promise<T> {
    // A deadline is essential on flaky tunnels: a request stuck in a half-open VPN path would otherwise
    // hang the caller's poll cycle forever, pinning the host as unreachable even after the tunnel recovers.
    const res = await this.send(path, { ...init, timeout: 10_000 })
    if (res.status === 401) throw new Error(`${this.host.name}: pairing expired — re-pair this host`)
    if (!res.ok) throw new Error(`${this.host.name}: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300))
    return (await res.json()) as T
  }

  info = () => this.request<{ version: string; capabilities?: Record<string, boolean> }>("/api/info")

  models = (directory: string) => this.request<{ data: { id: string; modelID: string; providerID: string; name: string; limit?: { context: number }; variants: { id: string }[] }[] }>(`/api/model?${loc({ directory })}`)
  context = (id: string) => this.request<{ data: unknown[] }>(`/api/session/${id}/context`)
  diff = (id: string) => this.request<{ data: { file: string; patch: string; additions: number; deletions: number; status: "added" | "deleted" | "modified" }[] }>(`/api/session/${id}/diff?context=3`)
  permissions = (id: string) => this.request<{ data: { permissions?: { action: string; resource: string; effect: "allow" | "deny" | "ask" }[] } }>(`/api/session/${id}`).then((r) => r.data)
  setPermissions = async (id: string, permissions: { action: string; resource: string; effect: "allow" | "deny" | "ask" }[]) => {
    const res = await this.send(`/api/session/${id}`, { method: "PATCH", body: JSON.stringify({ permissions }) })
    if (!res.ok) throw new Error(`Could not update permissions (${res.status})`)
  }
  switchModel = async (id: string, model: { providerID: string; modelID: string; variant?: string }) => {
    const res = await this.send(`/api/session/${id}/model`, {
      method: "POST",
      body: JSON.stringify({ model: { id: model.modelID, providerID: model.providerID, ...(model.variant ? { variant: model.variant } : {}) } }),
    })
    if (!res.ok) throw new Error(`Could not switch model (${res.status})`)
  }

  projects = () => this.request<{ id: string; name?: string; canonical?: string }[]>("/api/project")

  createSession = (directory: string) => this.request<{ data: { id: string; title?: string } }>("/api/session", { method: "POST", body: JSON.stringify({ location: { directory } }) }).then((r) => r.data)

  sessions = (query: string) =>
    this.request<{ data: unknown[]; cursor?: { next: string | null } }>(`/api/session?${query}`)

  active = () => this.request<{ data: Record<string, { type: string }> }>("/api/session/active")

  session = (id: string) => this.request<{ data: { id: string; parentID?: string; title?: string; model?: { id: string; providerID: string; variant?: string }; cost?: number; time?: { created: number; updated: number; idle?: number; viewed?: number }; outcome?: unknown; location?: { directory: string } } }>(`/api/session/${id}`).then((r) => r.data)

  // Reports the idle transition the viewer observed, so the server marks the finished turn read
  // (POST returns NoContent; the json read below rejecting on the empty body is expected and ignored).
  markViewed = (id: string, idle: number) => this.request<never>(`/api/session/${id}/view`, { method: "POST", body: JSON.stringify({ idle }) }).catch(() => {})

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
    const res = await this.send(`/api/session/${sessionID}/background`, { method: "POST" })
    if (!res.ok) throw new Error(`Could not background tools (${res.status})`)
  }

  forms = (sessionID: string) => this.request<{ data: Omit<SessionForm, "host">[] }>(`/api/session/${sessionID}/form`)
    .then((r) => r.data.map((form) => ({ ...form, host: this.host.id })))

  answerForm = async (sessionID: string, formID: string, answer: Record<string, FormValue>) => {
    const res = await this.send(`/api/session/${sessionID}/form/${formID}/reply`, { method: "POST", body: JSON.stringify({ answer }) })
    if (!res.ok) throw new Error(`Could not submit answers (${res.status}): ${await res.text()}`.slice(0, 300))
  }

  // Live shell output for the session screen: running shells at a location are listed (exited ones
  // are excluded), and each shell's captured stdout/stderr is paged by byte cursor.
  runningShells = (directory: string) =>
    this.request<{ data: { id: string; command: string; metadata?: Record<string, unknown> }[] }>(`/api/shell?${loc({ directory })}`)

  shellOutput = (id: string, directory: string, cursor?: number) =>
    this.request<{ data: { output: string; cursor: number } }>(
      `/api/shell/${id}/output?${loc({ directory })}&limit=8000${cursor !== undefined ? `&cursor=${cursor}` : ""}`,
    )

  fsList = (l: Location, path: string) =>
    this.request<{ data: FileEntry[] }>(`/api/fs/list?${loc(l)}&path=${encodeURIComponent(path)}`)

  // Raw-bytes upload to the server's filesystem; returns the resolved absolute path that
  // voice.transcribe reads back. Missing parent directories are created server-side.
  fsWrite = async (directory: string, path: string, bytes: Uint8Array): Promise<string> => {
    const res = await this.send(`/api/experimental/fs/write?${loc({ directory })}&path=${encodeURIComponent(path)}`, {
      method: "POST",
      body: bytes,
      contentType: "application/octet-stream",
      timeout: 120_000,
    })
    if (res.status === 401) throw new Error(`${this.host.name}: pairing expired — re-pair this host`)
    if (!res.ok) throw new Error(`${this.host.name}: fs/write ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300))
    return ((await res.json()) as { data: { path: string } }).data.path
  }

  voiceTranscribe = (body: {
    audioPath: string
    recordingId?: string
    sessionID?: string
    title?: string
    device?: string
    duration?: number
    recordedAt?: number
    language?: string
  }) =>
    this.request<{ data: { jobID: string; sessionID: string } }>("/api/experimental/voice/transcribe", {
      method: "POST",
      body: JSON.stringify(body),
    })

  // Pending voice-note cards from the shared Voice Inbox session; only the synthetic
  // voice entries are user-visible, delivered ones are already gone from this listing.
  voicePending = () =>
    this.request<{
      data: { id: string; type: string; time?: { created?: number | string }; payload?: { text?: string; metadata?: Record<string, unknown> } }[]
    }>(`/api/session/ses_voice_inbox/inbox`).then((r): VoicePendingCard[] =>
      r.data
        .filter((entry) => entry.type === "synthetic" && entry.payload?.metadata?.source === "voice")
        .map((entry) => ({
          id: entry.id,
          created: epochMillis(entry.time?.created),
          recordedAt: epochMillis(entry.payload?.metadata?.recordedAt),
          duration: typeof entry.payload?.metadata?.duration === "number" ? entry.payload.metadata.duration : undefined,
          title: typeof entry.payload?.metadata?.title === "string" ? entry.payload.metadata.title : undefined,
          summary: typeof entry.payload?.metadata?.summary === "string" ? entry.payload.metadata.summary : undefined,
          project: typeof entry.payload?.metadata?.suggestedProject === "string" ? entry.payload.metadata.suggestedProject : undefined,
          text: typeof entry.payload?.text === "string" ? entry.payload.text : undefined,
        })),
    )

  voiceAccept = (itemId: string, sessionID: string) =>
    this.request<unknown>("/api/experimental/voice/accept", { method: "POST", body: JSON.stringify({ itemId, sessionID }) })

  voiceRemember = (itemId: string, directory?: string) =>
    this.request<unknown>("/api/experimental/voice/remember", {
      method: "POST",
      body: JSON.stringify(directory ? { itemId, directory } : { itemId }),
    })

  fsRead = async (l: Location, path: string, limit = 2_000_000): Promise<FileContent> => {
    const encodedPath = path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")
    const res = await this.send(`/api/fs/read/${encodedPath}?${loc(l)}`, { accept: "application/octet-stream" })
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
    const res = await this.send(`/api/session/${sessionID}/permission/${requestID}/reply`, {
      method: "POST",
      body: JSON.stringify({ decision }),
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
          const res = await streamingFetch(`${this.base()}/api/event`, {
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
          // A dead stream with no HTTP status is a transport failure: probe LAN so the next
          // reconnect rides the local path when the tailnet is what broke.
          if (!this.lanOrigin) {
            this.lanProbe ??= findLanOrigin(this.host.id, this.host.origin, this.token)
            void this.lanProbe.then((lan) => { if (lan && !this.lanOrigin) this.lanOrigin = lan })
          }
        }
        await new Promise((r) => setTimeout(r, 3000))
      }
    })()

  static redeem = (link: string) =>
    fetch(link, { headers: { accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) {
          // The server explains 401s ("Pairing link expired or already used"); show it instead of guessing.
          const message: string | undefined = (await res.json().catch(() => undefined))?.message
          throw new Error(message ?? `Pairing link failed (${res.status}). Is the host awake and on Tailscale?`)
        }
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

// Server time fields arrive as epoch milliseconds; Date.parse(number) coerces to a
// numeric string and silently yields NaN, which is why cards rendered no timestamp.
const epochMillis = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || value.trim() === "") return undefined
  if (Number.isFinite(+value)) return +value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
