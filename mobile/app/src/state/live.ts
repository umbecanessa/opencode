import { useEffect, useRef, useState } from "react"
import { Client } from "../api/client"
import { useHosts } from "./hosts"

export type Live = {
  running: Set<string>
  waiting: Set<string>
  online: Record<string, boolean>
  refresh: () => void
}

const key = (host: string, session: string) => `${host}/${session}`

export const useLive = (intervalMs = 5000): Live => {
  const { hosts, client } = useHosts()
  const [running, setRunning] = useState<Set<string>>(new Set())
  const [waiting, setWaiting] = useState<Set<string>>(new Set())
  const [online, setOnline] = useState<Record<string, boolean>>({})
  const [tick, setTick] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      const results = await Promise.allSettled(
        hosts.map(async (h) => {
          const c = client(h.id)
          if (!c) return { id: h.id, active: [] as string[], perms: [] as string[] }
          const [act, perms] = await Promise.all([c.active(), c.permissionRequests()])
          return {
            id: h.id,
            active: Object.keys(act.data),
            perms: [...new Set(perms.data.map((p) => p.sessionID))],
          }
        }),
      )
      if (cancelled) return
      const nextRunning = new Set<string>()
      const nextWaiting = new Set<string>()
      const nextOnline: Record<string, boolean> = {}
      results.forEach((r, i) => {
        const id = hosts[i].id
        if (r.status !== "fulfilled") {
          nextOnline[id] = false
          return
        }
        nextOnline[id] = true
        r.value.active.forEach((s) => nextRunning.add(key(id, s)))
        r.value.perms.forEach((s) => nextWaiting.add(key(id, s)))
      })
      setRunning(nextRunning)
      setWaiting(nextWaiting)
      setOnline(nextOnline)
      timer.current = setTimeout(poll, intervalMs)
    }
    poll()
    return () => {
      cancelled = true
      clearTimeout(timer.current)
    }
  }, [hosts, client, intervalMs, tick])

  return { running, waiting, online, refresh: () => setTick((t) => t + 1) }
}

export const statusOf = (live: Live, host: string, sessionID: string): "running" | "waiting" | "done" =>
  live.waiting.has(key(host, sessionID)) ? "waiting" : live.running.has(key(host, sessionID)) ? "running" : "done"
