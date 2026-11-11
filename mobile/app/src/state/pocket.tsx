import AsyncStorage from "@react-native-async-storage/async-storage"
import * as SecureStore from "expo-secure-store"
import { createContext, useContext, useEffect, useState } from "react"
import { Client } from "../api/client"
import { PocketDevice } from "../pocket/device"
import { PairRefusedError, pairPocket, pullPocket, type PocketRecording, type PullProgress } from "../pocket/sync"
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
  pairing: boolean
  needsKey: boolean
  progress?: PullProgress
  error?: string
  recent: Ship[]
  scan: () => Promise<void>
  pick: (device?: Device) => Promise<void>
  pair: (device: Device, key?: string) => Promise<void>
  pull: () => Promise<void>
}

// Same alphabet pocket-libre uses; the first 8 characters double as the
// recorder's WiFi AP password, so treat the key as a secret.
export function generatePocketKey() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("")
}

const PocketContext = createContext<PocketState | undefined>(undefined)

export const PocketProvider = ({ children }: { children: React.ReactNode }) => {
  const hosts = useHosts()
  const [hasKey, setHasKey] = useState(false)
  const [device, setDevice] = useState<Device>()
  const [devices, setDevices] = useState<Device[]>([])
  const [scanning, setScanning] = useState(false)
  const [pairing, setPairing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [needsKey, setNeedsKey] = useState(false)
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

  const scan = async () => {
    setScanning(true)
    setError(undefined)
    setNeedsKey(false)
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

  // Handshake a recorder with zero user input: a hardware-reset device adopts whatever
  // key we send first, and an already-paired one accepts the key stored in the keychain
  // (pairPocket doubles as adoption). Only a refusal by a stranger-keyed device surfaces.
  const pair = async (next: Device, explicit?: string) => {
    setPairing(true)
    setError(undefined)
    setNeedsKey(false)
    try {
      const saved = await SecureStore.getItemAsync(KEY_STORE).catch(() => null)
      const clean = explicit?.trim().toUpperCase()
      if (clean && !/^[A-Z0-9]{16}$/.test(clean)) {
        setError("The session key must be 16 characters (A–Z, 0–9).")
        return
      }
      const key = clean ?? saved ?? generatePocketKey()
      await pairPocket({ device: next, key })
      await SecureStore.setItemAsync(KEY_STORE, key)
      setHasKey(true)
      await pick(next)
    } catch (e) {
      if (e instanceof PairRefusedError) setNeedsKey(true)
      setError(message(e))
    } finally {
      setPairing(false)
    }
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
  return <PocketContext.Provider value={{ hasKey, device, devices, scanning, busy, pairing, needsKey, progress, error, recent, scan, pick, pair, pull }}>{children}</PocketContext.Provider>
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
