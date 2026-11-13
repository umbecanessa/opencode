import AsyncStorage from "@react-native-async-storage/async-storage"
import * as SecureStore from "expo-secure-store"
import { createContext, useContext, useEffect, useRef, useState } from "react"
import { AppState } from "react-native"
import { consumePendingIntentAction } from "../../modules/pocket"
import { Client } from "../api/client"
import type { VoicePendingCard } from "../api/types"
import { PocketDevice } from "../pocket/device"
import { PairRefusedError, pairPocket, pullPocket, setRemoteRecording, type PocketRecording, type PullProgress } from "../pocket/sync"
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
  recording: boolean
  recBusy: boolean
  recordingName?: string
  progress?: PullProgress
  error?: string
  recent: Ship[]
  pending: VoicePendingCard[]
  pendingBusy?: string
  notesLoaded: boolean
  processing: { key: string; label: string; mins: number }[]
  scan: () => Promise<void>
  pick: (device?: Device) => Promise<void>
  pair: (device: Device, key?: string) => Promise<void>
  startRecording: () => Promise<void>
  stopRecording: () => Promise<void>
  runDeepAction: (action: string | null | undefined) => void
  pull: () => Promise<void>
  loadPending: () => Promise<void>
  acceptPending: (id: string, sessionID: string) => Promise<void>
  rememberPending: (id: string) => Promise<void>
  dismissPending: (id: string) => Promise<void>
  listSessions: () => Promise<{ id: string; title?: string }[]>
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
  const [recording, setRecording] = useState(false)
  const [recBusy, setRecBusy] = useState(false)
  const [recordingName, setRecordingName] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [needsKey, setNeedsKey] = useState(false)
  const [progress, setProgress] = useState<PullProgress>()
  const [error, setError] = useState<string>()
  const [recent, setRecent] = useState<Ship[]>([])
  const [pending, setPending] = useState<VoicePendingCard[]>([])
  const [pendingBusy, setPendingBusy] = useState<string>()
  // False until the first inbox fetch settles, so the screen can show a loading row instead of
  // an empty "Pending notes" void while the host answers over the tunnel.
  const [notesLoaded, setNotesLoaded] = useState(false)
  const [processing, setProcessing] = useState<{ key: string; label: string; mins: number }[]>([])
  // Recordings whose card has been seen or consumed; keeps shipped history rows from
  // reappearing as "processing" forever (or after triage).
  const resolved = useRef<Set<string>>(new Set())

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

  // Recording lives on the device once started, so the flag only reflects what this
  // app knows; the recorder's own button moves ahead of it either way.
  const startRecording = async () => {
    const key = await SecureStore.getItemAsync(KEY_STORE).catch(() => null)
    if (!key || !device) {
      setError("Pair the recorder first.")
      return
    }
    setRecBusy(true)
    setError(undefined)
    try {
      const { name } = await setRemoteRecording({ device, key, on: true })
      setRecording(true)
      setRecordingName(name)
    } catch (e) {
      setError(message(e))
    } finally {
      setRecBusy(false)
    }
  }

  // Stopping ships the fresh recording right away: pull sees it in the device listing.
  // One blind retry: the recorder is flaky about accepting a fresh connection while
  // its mic is hot (same family as the post-recording wedge), and a short settle
  // delay gives the link a chance before the second attempt.
  const stopRecording = async () => {
    const key = await SecureStore.getItemAsync(KEY_STORE).catch(() => null)
    if (!key || !device) {
      setError("Pair the recorder first.")
      return
    }
    setRecBusy(true)
    setError(undefined)
    try {
      try {
        await setRemoteRecording({ device, key, on: false })
      } catch {
        await sleep(2_500)
        await setRemoteRecording({ device, key, on: false })
      }
      setRecording(false)
      setRecordingName(undefined)
    } catch (e) {
      setError(`Could not stop the recorder: ${message(e)}. It keeps recording — its own button always works.`)
      return
    } finally {
      setRecBusy(false)
    }
    // Let the device close out the file before the pull lists it.
    await sleep(1_500)
    await pull()
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
      // Key format must match pullPocket's filter (`date/name`) — a mismatch silently re-ships everything.
      const skip = new Set(recent.filter((s) => s.host === host.id).map((s) => `${s.date}/${s.name}`))
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
    // Cards appear a beat after the upload (the server's transcribe job lands in ~15s),
    // so the list refreshes right after a pull; the screen polls for the late arrivals.
    void loadPending()
  }

  // Triage lives on the Voice Inbox of the first paired machine — the same host pull ships to.
  const triageClient = () => {
    const host = hosts.hosts[0]
    const client = host ? hosts.client(host.id) : undefined
    if (!client) throw new Error("Pair a host first — voice notes live on the first paired machine.")
    return client
  }

// A shipped clip stops showing as "processing" this long after upload even if no card landed
// (whisper down, job lost in a server restart); the shipped row then goes quiet.
const PROCESSING_WINDOW = 30 * 60_000

  const loadPending = async () => {
    try {
      const cards = await triageClient().voicePending()
      for (const card of cards) if (card.recordingId) resolved.current.add(card.recordingId)
      setPending(cards)
      const stamp = Date.now()
      setProcessing(
        recent
          .filter((s) => stamp - s.at < PROCESSING_WINDOW && !resolved.current.has(`${s.date}_${s.name}`))
          .map((s) => ({ key: `${s.date}_${s.name}`, label: `${s.date} ${s.name}`, mins: Math.max(1, Math.round((stamp - s.at) / 60_000)) })),
      )
      setNotesLoaded(true)
    } catch {
      // An unreachable host is not a screen error: the pending section simply stays as-is.
      setNotesLoaded(true)
    }
  }

  // While any shipped clip still awaits its card, poll faster than the screen's 15s cycle.
  useEffect(() => {
    if (processing.length === 0) return
    const timer = setTimeout(() => void loadPending(), 8_000)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processing, pending])

  // "Add to this session": the server moves the note into the picked session's inbox
  // (idempotent per session and recording) and consumes it from the Voice Inbox.
  const acceptPending = async (id: string, sessionID: string) => {
    setPendingBusy(id)
    try {
      await triageClient().voiceAccept(id, sessionID)
      const card = pending.find((c) => c.id === id)
      if (card?.recordingId) resolved.current.add(card.recordingId)
      setPending((prev) => prev.filter((card) => card.id !== id))
    } catch (e) {
      setError(message(e))
    } finally {
      setPendingBusy(undefined)
    }
  }

  // "Remember for project": the note becomes a memory of the project the recordings
  // ship into (same resolver as pull), without being delivered to any session.
  const rememberPending = async (id: string) => {
    setPendingBusy(id)
    try {
      const client = triageClient()
      await client.voiceRemember(id, await resolveDirectory(client))
      const card = pending.find((c) => c.id === id)
      if (card?.recordingId) resolved.current.add(card.recordingId)
      setPending((prev) => prev.filter((card) => card.id !== id))
    } catch (e) {
      setError(message(e))
    } finally {
      setPendingBusy(undefined)
    }
  }

  // Throw the note away: cancelled in the Voice Inbox, delivered nowhere. The recording file
  // itself stays on the host until the 30-day retention sweep.
  const dismissPending = async (id: string) => {
    setPendingBusy(id)
    try {
      await triageClient().voiceDismiss(id)
      const card = pending.find((c) => c.id === id)
      if (card?.recordingId) resolved.current.add(card.recordingId)
      setPending((prev) => prev.filter((card) => card.id !== id))
    } catch (e) {
      setError(message(e))
    } finally {
      setPendingBusy(undefined)
    }
  }

  const listSessions = async () => {
    const page = await triageClient().sessions("limit=20&order=desc")
    return (page.data as { id: string; title?: string }[]).map((s) => ({ id: s.id, title: s.title }))
  }

  useEffect(() => {
    void loadPending()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // One entry point for every deep-link flavor (route params, URL events, the native
  // App Intent's stashed action). Last-fired gating means a delivery that arrives
  // through two paths at once still performs the toggle exactly once.
  const lastActionAt = useRef(0)
  const runDeepAction = (action: string | null | undefined) => {
    if (action !== "record" && action !== "pull") return
    if (Date.now() - lastActionAt.current < 3_000) return
    lastActionAt.current = Date.now()
    if (!device) void scan()
    else if (action === "record") void (recording ? stopRecording() : startRecording())
    else void pull()
  }

  // The App Intent cannot reach JS by any event when the app is already active, so
  // the stashed flag is polled app-wide — cheap UserDefaults reads, and this is the
  // only reliable delivery path iOS leaves for in-process intents. No deps: the
  // effect must close over fresh state each render (the context object is rebuilt
  // per render anyway).
  useEffect(() => {
    const run = () => runDeepAction(consumePendingIntentAction())
    run()
    const timer = setInterval(run, 1_200)
    const sub = AppState.addEventListener("change", (s) => s === "active" && run())
    return () => {
      clearInterval(timer)
      sub.remove()
    }
  })

  // Plain object: the provider only re-renders when its own state or the host list changes,
  // which is exactly when the Pocket screen should update.
  return <PocketContext.Provider value={{ hasKey, device, devices, scanning, busy, pairing, needsKey, recording, recBusy, recordingName, progress, error, recent, pending, pendingBusy, notesLoaded, processing, scan, pick, pair, startRecording, stopRecording, pull, runDeepAction, loadPending, acceptPending, rememberPending, dismissPending, listSessions }}>{children}</PocketContext.Provider>
}

export function usePocket() {
  const ctx = useContext(PocketContext)
  if (!ctx) throw new Error("usePocket must be used within PocketProvider")
  return ctx
}

// Recordings land under a project directory on the host (persistent, user-owned); the server
// creates the voice/pocket tree inside it. Any session directory works as a fallback.
export async function resolveDirectory(client: Client) {
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

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
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
