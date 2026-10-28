import { Database } from "bun:sqlite"
import { preview } from "./preview"

type Kind = "completed" | "failed" | "approval" | "question"
type Host = { id: string; origin: string; tokenEnv: string; subscriptions: string[]; events: Kind[]; previews?: boolean }
type Config = { hosts: Host[] }
type Session = { id: string; title?: string; agent?: string; parentID?: string; outcome?: unknown; time: { updated: number } }
const config: Config = await Bun.file(process.env.BRIDGE_CONFIG ?? "config.json").json()
const appID = process.env.ONESIGNAL_APP_ID
const apiKey = process.env.ONESIGNAL_API_KEY
if (!appID || !apiKey) throw new Error("Set ONESIGNAL_APP_ID and ONESIGNAL_API_KEY in the private environment file")
config.hosts.forEach((host) => {
  const url = new URL(host.origin)
  if (!["http:", "https:"].includes(url.protocol) || !host.id || !process.env[host.tokenEnv]) throw new Error("Invalid host configuration or missing credential")
  if (!host.subscriptions.length) throw new Error("Enroll at least one subscription per host")
})
const db = new Database(process.env.BRIDGE_DB ?? "bridge.sqlite", { create: true })
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS outbox (key TEXT PRIMARY KEY, idempotency TEXT NOT NULL, payload TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY)")
const record = db.transaction((key: string, payload: object) => {
  if (!db.query("INSERT OR IGNORE INTO seen VALUES (?)").run(key).changes) return
  db.query("INSERT INTO outbox (key,idempotency,payload) VALUES (?,?,?)").run(key, crypto.randomUUID(), JSON.stringify(payload))
})
const request = async <T>(host: Host, path: string): Promise<T> => {
  const res = await fetch(`${host.origin}${path}`, { headers: { authorization: `Basic ${btoa(`opencode:${process.env[host.tokenEnv]}`)}` }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`Host request failed (${res.status})`)
  return res.json() as Promise<T>
}
const text: Record<Kind, string> = { completed: "An agent finished its work.", failed: "An agent needs attention after a failure.", approval: "An agent is waiting for your approval.", question: "An agent has a question for you." }
async function observe(host: Host) {
  const [active, page] = await Promise.all([
    request<{ data: Record<string, unknown> }>(host, "/api/session/active"),
    request<{ data: Session[] }>(host, "/api/session?limit=100&order=desc"),
  ])
  const baseline = !db.query("SELECT id FROM hosts WHERE id=?").get(host.id)
  const notify = (kind: Kind, sessionID: string, identity: string, reply?: string) => {
    const key = `${host.id}/${kind}/${identity}`
    if (!host.events.includes(kind)) return
    if (baseline && (kind === "completed" || kind === "failed")) {
      db.query("INSERT OR IGNORE INTO seen VALUES (?)").run(key)
      return
    }
    const session = page.data.find((s) => s.id === sessionID)
    const heading = host.previews ? preview(session?.title || "OpenCode", 90) : "OpenCode"
    const subtitle = host.previews ? `${session?.agent || "Agent"} · ${kind === "completed" ? "Finished" : kind === "failed" ? "Failed" : kind === "approval" ? "Approval needed" : "Question"}` : undefined
    record(key, { app_id: appID, include_subscription_ids: host.subscriptions, headings: { en: heading }, ...(subtitle ? { subtitle: { en: subtitle } } : {}), contents: { en: host.previews && reply ? preview(reply) || text[kind] : text[kind] }, data: { host: host.id, sessionID }, target_channel: "push" })
  }
  for (const session of page.data.filter((s) => !s.parentID && !active.data[s.id] && s.outcome)) {
    const outcome = typeof session.outcome === "string" ? session.outcome : (session.outcome as { type?: string }).type
    if (outcome !== "succeeded" && outcome !== "failed") continue
    // Use the durable idle marker rather than session.updated: renaming/archiving a
    // finished session must not create a new completion alert.
    const messages = await request<{ data: { id: string; type: string; outcome?: string; content?: { type: string; text?: string }[] }[] }>(host, `/api/session/${session.id}/message?limit=50`)
    const idle = messages.data.find((m) => m.type === "idle")
    if (idle && (idle.outcome === "succeeded" || idle.outcome === "failed")) {
      const turn = messages.data.slice(messages.data.indexOf(idle) + 1)
      const boundary = turn.findIndex((m) => m.type === "user" || m.type === "idle")
      const reply = turn.slice(0, boundary < 0 ? undefined : boundary)
        .find((m) => m.type === "assistant" && m.content?.some((p) => p.type === "text" && p.text?.trim()))
        ?.content?.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n")
      notify(idle.outcome === "failed" ? "failed" : "completed", session.id, idle.id, reply)
    }
  }
  for (const sessionID of Object.keys(active.data)) {
    const [permissions, forms] = await Promise.all([
      request<{ data: { id: string }[] }>(host, `/api/session/${sessionID}/permission`),
      request<{ data: { id: string }[] }>(host, `/api/session/${sessionID}/form`),
    ])
    permissions.data.forEach((p) => notify("approval", sessionID, p.id))
    forms.data.forEach((f) => notify("question", sessionID, f.id))
  }
  db.query("INSERT OR IGNORE INTO hosts VALUES (?)").run(host.id)
}
async function deliver() {
  const rows = db.query<{ key: string; idempotency: string; payload: string }, []>("SELECT key,idempotency,payload FROM outbox WHERE sent=0 LIMIT 20").all()
  for (const row of rows) {
    const res = await fetch("https://api.onesignal.com/notifications", { method: "POST", headers: { authorization: `Key ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ ...JSON.parse(row.payload), idempotency_key: row.idempotency }), signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`OneSignal request failed (${res.status})`)
    const result = await res.json() as { id?: string }
    if (!result.id) throw new Error("OneSignal did not accept a message for the configured subscriptions")
    db.query("UPDATE outbox SET sent=1 WHERE key=?").run(row.key)
  }
}
while (true) {
  await Promise.allSettled(config.hosts.map(async (host) => {
    await observe(host).catch(() => console.error(JSON.stringify({ event: "host_observation_failed", host: host.id })))
  }))
  await deliver().catch(() => console.error(JSON.stringify({ event: "notification_delivery_failed" })))
  await Bun.sleep(10_000)
}
