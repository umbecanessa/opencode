import { useEffect, useRef, useState } from "react"
import type { PermissionRequest } from "../api/types"
import { useHosts } from "./hosts"

export type Live = {
  running: Set<string>
  waiting: Set<string>
  requests: PermissionRequest[]
  online: Record<string, boolean>
  refresh: () => void
}

export const liveKey = (host: string, session: string) => `${host}/${session}`

export const useLive = (intervalMs = 5000): Live => {
  const { hosts, client } = useHosts()
  const [running, setRunning] = useState<Set<string>>(new Set())
  const [requests, setRequests] = useState<PermissionRequest[]>([])
  const [online, setOnline] = useState<Record<string, boolean>>({})
  const [tick, setTick] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      const results = await Promise.allSettled(
        hosts.map(async (h) => {
          const c = client(h.id)
          if (!c) return { id: h.id, active: [] as string[], perms: [] as PermissionRequest[] }
          const active = Object.keys((await c.active()).data)
          // A session blocked on approval is still active, so its own permission list is the reliable source.
          const perms = await Promise.allSettled(active.map((s) => c.sessionPermissions(s)))
          return { id: h.id, active, perms: perms.flatMap((p) => (p.status === "fulfilled" ? p.value : [])) }
        }),
      )
      if (cancelled) return
      const nextRunning = new Set<string>()
      const nextRequests: PermissionRequest[] = []
      const nextOnline: Record<string, boolean> = {}
      results.forEach((r, i) => {
        const id = hosts[i].id
        if (r.status !== "fulfilled") {
          nextOnline[id] = false
          return
        }
        nextOnline[id] = true
        r.value.active.forEach((s) => nextRunning.add(liveKey(id, s)))
        nextRequests.push(...r.value.perms)
      })
      setRunning(nextRunning)
      setRequests(nextRequests)
      setOnline(nextOnline)
      timer.current = setTimeout(poll, intervalMs)
    }
    poll()
    return () => {
      cancelled = true
      clearTimeout(timer.current)
    }
  }, [hosts, client, intervalMs, tick])

  const waiting = new Set(requests.map((p) => liveKey(p.host, p.sessionID)))
  return { running, waiting, requests, online, refresh: () => setTick((t) => t + 1) }
}

export const statusOf = (live: Live, host: string, sessionID: string): "running" | "waiting" | "done" =>
  live.waiting.has(liveKey(host, sessionID)) ? "waiting" : live.running.has(liveKey(host, sessionID)) ? "running" : "done"

// A parent reflects its subagents: a blocked child means the whole task needs you.
export const familyStatus = (live: Live, host: string, ids: string[]) => {
  const all = ids.map((id) => statusOf(live, host, id))
  return all.includes("waiting") ? "waiting" : all.includes("running") ? "running" : "done"
}
