import AsyncStorage from "@react-native-async-storage/async-storage"
import * as SecureStore from "expo-secure-store"
import { createContext, useContext, useEffect, useState } from "react"
import { Client } from "../api/client"
import { PocketDevice } from "../pocket/device"
import { pullPocket, type PocketRecording, type PullProgress } from "../pocket/sync"
import { useHosts } from "./hosts"

const KEY_STORE = "pocket_session_key"
const DEVICE_KEY = "pocket_device"
const SHIPPED_KEY = "pocket_shipped"
// BLE streams at ~4 KB/s of audio; even a long catch-up pull should finish well inside this.
const PULL_TIMEOUT = 30 * 60_000

type Device = { id: string; name: string }
type Ship = PocketRecording & { at: number; host: string }

type PocketState = {
  hasKey: boolean
  device?: Device
  devices: Device[]
  scanning: boolean
  busy: boolean
  progress?: PullProgress
  error?: string
  recent: Ship[]
  saveKey: (key: string) => Promise<void>
  scan: () => Promise<void>
  pick: (device?: Device) => Promise<void>
  pull: () => Promise<void>
}

const PocketContext = createContext<PocketState | undefined>(undefined)

export const PocketProvider = ({ children }: { children: React.ReactNode }) => {
  const hosts = useHosts()
  const [hasKey, setHasKey] = useState(false)
  const [device, setDevice] = useState<Device>()
  const [devices, setDevices] = useState<Device[]>([])
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<PullProgress>()
  const [error, setError] = useState<string>()
  const [recent, setRecent] = useState<Ship[]>([])

  useEffect(() => {
    SecureStore.getItemAsync(KEY_STORE)
      .then((saved) => setHasKey(!!saved))
      .catch(() => {})
    AsyncStorage.multiGet([DEVICE_KEY, SHIPPED_KEY]).then(([savedDevice, savedShipped]) => {
      if (savedDevice[1]) setDevice(JSON.parse(savedDevice[1]) as Device)
      if (savedShipped[1]) setRecent(JSON.parse(savedShipped[1]) as Ship[])
    })
  }, [])

  const saveKey = async (value: string) => {
    const clean = value.trim()
    if (!clean) return
    await SecureStore.setItemAsync(KEY_STORE, clean)
    setHasKey(true)
  }

  const scan = async () => {
    setScanning(true)
    setError(undefined)
    try {
      const found = await PocketDevice.scan()
      setDevices(found.sort((a, b) => a.name.localeCompare(b.name)))
      if (!found.length) setError("No Pocket found. Wake it (short press) and keep it close.")
    } catch (e) {
      setError(message(e))
    } finally {
      setScanning(false)
    }
  }

  const pick = async (next?: Device) => {
    setDevice(next)
    setDevices([])
    if (next) await AsyncStorage.setItem(DEVICE_KEY, JSON.stringify(next))
    else await AsyncStorage.removeItem(DEVICE_KEY)
  }

  const pull = async () => {
    const key = await SecureStore.getItemAsync(KEY_STORE).catch(() => null)
    if (!key || !device) return
    const host = hosts.hosts[0]
    const client = host ? hosts.client(host.id) : undefined
    if (!host || !client) {
      setError("Pair a host first — recordings ship to the first paired machine.")
      return
    }
    setBusy(true)
    setError(undefined)
    setProgress({ phase: "connecting", done: 0, total: 0 })
    try {
      // The skip-list is the shipped history: anything already handed to this host is not re-pulled.
      const skip = new Set(recent.filter((s) => s.host === host.id).map((s) => `${s.date}:${s.name}`))
      const directory = await resolveDirectory(client)
      const result = await withTimeout(
        pullPocket({ client, directory, device, key, skip, onProgress: setProgress }),
        PULL_TIMEOUT,
      )
      const shipped = result.shipped.map((r) => ({ ...r, at: Date.now(), host: host.id }))
      setRecent((prev) => {
        const next = [...shipped, ...prev].slice(0, 100)
        AsyncStorage.setItem(SHIPPED_KEY, JSON.stringify(next)).catch(() => {})
        return next
      })
      setError(
        result.shipped.length
          ? undefined
          : result.skipped
            ? "Nothing new — everything on the recorder was already shipped."
            : "The recorder holds no recordings.",
      )
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
      setProgress(undefined)
    }
  }

  // Plain object: the provider only re-renders when its own state or the host list changes,
  // which is exactly when the Pocket screen should update.
  return <PocketContext.Provider value={{ hasKey, device, devices, scanning, busy, progress, error, recent, saveKey, scan, pick, pull }}>{children}</PocketContext.Provider>
}

export function usePocket() {
  const ctx = useContext(PocketContext)
  if (!ctx) throw new Error("usePocket must be used within PocketProvider")
  return ctx
}

// Recordings land under a project directory on the host (persistent, user-owned); the server
// creates the voice/pocket tree inside it. Any session directory works as a fallback.
async function resolveDirectory(client: Client) {
  const projects = await client.projects().catch(() => [])
  const project = projects.find((p) => p.canonical)?.canonical
  if (project) return project
  const sessions = await client.sessions("limit=1&order=desc").catch(() => undefined)
  const directory = (sessions?.data[0] as { location?: { directory?: string } } | undefined)?.location?.directory
  if (directory) return directory
  throw new Error("The host has no projects yet — open one session there first.")
}

function message(e: unknown) {
  return e instanceof Error ? e.message : String(e)
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the pull took too long and was stopped")), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}
