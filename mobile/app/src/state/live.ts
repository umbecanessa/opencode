import { useEffect, useRef, useState } from "react"
import { AppState } from "react-native"
import type { PermissionRequest, SessionForm } from "../api/types"
import type { SessionStatus } from "../theme"
import { useHosts } from "./hosts"

export type Live = {
  running: Set<string>
  waiting: Set<string>
  requests: PermissionRequest[]
  forms: SessionForm[]
  online: Record<string, boolean>
  refresh: () => void
}

export const liveKey = (host: string, session: string) => `${host}/${session}`

export const useLive = (intervalMs = 5000): Live => {
  const { hosts, client } = useHosts()
  const [running, setRunning] = useState<Set<string>>(new Set())
  const [requests, setRequests] = useState<PermissionRequest[]>([])
  const [forms, setForms] = useState<SessionForm[]>([])
  const [online, setOnline] = useState<Record<string, boolean>>({})
  const [tick, setTick] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") setTick((t) => t + 1) })
    return () => subscription.remove()
  }, [])

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      const results = await Promise.allSettled(
        hosts.map(async (h) => {
          const c = client(h.id)
          if (!c) return { id: h.id, active: [] as string[], perms: [] as PermissionRequest[], forms: [] as SessionForm[] }
          const active = Object.keys((await c.active()).data)
          // A session blocked on approval is still active, so its own permission list is the reliable source.
          const perms = await Promise.allSettled(active.map((s) => c.sessionPermissions(s)))
          const forms = await Promise.allSettled(active.map((s) => c.forms(s)))
          return { id: h.id, active, perms: perms.flatMap((p) => (p.status === "fulfilled" ? p.value : [])), forms: forms.flatMap((f) => f.status === "fulfilled" ? f.value : []) }
        }),
      )
      if (cancelled) return
      const nextRunning = new Set<string>()
      const nextRequests: PermissionRequest[] = []
      const nextForms: SessionForm[] = []
      const nextOnline: Record<string, boolean> = {}
      results.forEach((r, i) => {
        const id = hosts[i].id
        if (r.status !== "fulfilled") {
          nextOnline[id] = false
          // Diagnostics: why the probe died (DNS/TLS/refused/HTTP status) lands in the Metro log.
          console.warn(`live: ${hosts[i].name} (${hosts[i].origin}) offline: ${String(r.reason)}`)
          return
        }
        nextOnline[id] = true
        r.value.active.forEach((s) => nextRunning.add(liveKey(id, s)))
        nextRequests.push(...r.value.perms)
        nextForms.push(...r.value.forms)
      })
      setRunning(nextRunning)
      setRequests(nextRequests)
      setForms(nextForms)
      setOnline(nextOnline)
      timer.current = setTimeout(poll, intervalMs)
    }
    poll()
    return () => {
      cancelled = true
      clearTimeout(timer.current)
    }
  }, [hosts, client, intervalMs, tick])

  const waiting = new Set([...requests, ...forms].map((p) => liveKey(p.host, p.sessionID)))
  return { running, waiting, requests, forms, online, refresh: () => setTick((t) => t + 1) }
}

export const statusOf = (live: Live, host: string, sessionID: string): "running" | "waiting" | "done" =>
  live.waiting.has(liveKey(host, sessionID)) ? "waiting" : live.running.has(liveKey(host, sessionID)) ? "running" : "done"

// A session whose last run ended failed, per the same outcome field the Activity filters read.
export const isFailed = (session: { outcome?: unknown }) =>
  session.outcome === "failed" || (typeof session.outcome === "object" && session.outcome !== null && "type" in session.outcome && (session.outcome as { type?: string }).type === "failed")

// The server tracks the idle transition and the last view against each session; a finished turn whose
// idle postdates the view (or was never viewed) is the desktop's blue unread dot.
export const isUnread = (session: { time?: { idle?: number; viewed?: number } }) =>
  session.time?.idle !== undefined && (session.time.viewed === undefined || session.time.idle > session.time.viewed)

// A parent reflects its subagents: a blocked child means the whole task needs you.
// The failed/unread flags carry the root session's own non-live state, ranked like the desktop sidebar:
// waiting and running outrank a stale failure or unread mark.
export const familyStatus = (
  live: Live,
  host: string,
  ids: string[],
  root?: { failed?: boolean; unread?: boolean },
): SessionStatus => {
  const all = ids.map((id) => statusOf(live, host, id))
  if (all.includes("waiting")) return "waiting"
  if (all.includes("running")) return "running"
  if (root?.failed) return "failed"
  if (root?.unread) return "unread"
  return "done"
}
