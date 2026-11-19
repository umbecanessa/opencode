import * as FileSystem from "expo-file-system/legacy"
import TcpSocket from "react-native-tcp-socket"
import type { Client } from "../api/client"
import { PocketDevice } from "./device"
import { LineInbox, listDates, listRecordings, type PocketRecording, type PullProgress } from "./sync"

// Quick Transfer over the recorder's own access point, ported from pocket-libre's
// WifiSession (PROTOCOL.md "WiFi Transfer (Fast)"): BLE stays the control channel
// (auth, WIFIO/WIFI/WIFIS/WPING, the per-file U& staging and the U&WIFI switch),
// and the MP3 bytes stream raw over TCP 192.168.200.1:8475 at ~1 MB/s.
//
// iOS-specific shape: joining a hidden network from an app needs the Hotspot
// framework entitlement, which we do not ship. The join is assisted instead — the
// device hands its SSID and password over BLE (APP&WIFI), the UI shows them with
// copy buttons, and the user joins in Settings like any Wi-Fi speaker. iOS
// remembers the network, so later transfers and AP restarts auto-rejoin while the
// app just waits for the device to report WIFIS=1 over the still-open BLE link.

const AP_HOST = "192.168.200.1"
const AP_PORT = 8475

// Ten fixed bytes follow every file on the socket; identical for every file
// (a trailer, not a checksum). Verified as bytes, not text.
const END_MARKER = Uint8Array.from([0xba, 0x5a, 0x02, 0x8f, 0x04, 0xba, 0x5a, 0x02, 0x8f, 0x04])

// The device serves two transfer connections per AP session on 1.8, one on 1.7.
const filesPerApSession = (firmware?: string) => (firmware?.startsWith("1.7") ? 1 : 2)

// Waits inside an AP restart; firmware 1.8 was seen to ignore the first WIFIO
// right after a failed transfer, and a later restart worked (pocket-libre parity).
const AP_RESTART_WAITS = [2_000, 5_000, 10_000]

const JOIN_TIMEOUT = 120_000
const WPING_INTERVAL = 5_000
const WIFIS_POLL_INTERVAL = 1_000
const SWITCH_DELAY = 300
const SOCKET_RETRY_WAIT = 15_000
const FIRST_BYTE_TIMEOUT = 15_000
const IDLE_TIMEOUT = 15_000
// 1 MB/s plus headroom is the observed ceiling; anything slower is a stall.
const transferBudget = (size: number) => Math.max(90_000, Math.ceil(size / 500) * 1_000)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export type QuickResult = {
  firmware?: string
  shipped: PocketRecording[]
  skipped: number
}

// One Quick Transfer: list, raise the AP, wait for the phone to join, stream every
// unshipped file into cache storage, then ship them over the normal network — the
// recorder's AP has no route to the host, so uploads run after the AP drops.
export async function quickTransferPocket(input: {
  client: Client
  directory: string
  device: { id: string; name: string }
  key: string
  skip: Set<string>
  onProgress?: (p: PullProgress) => void
  onJoin?: (network: { ssid: string; password: string; attempt: number }) => void
}): Promise<QuickResult> {
  const { client, directory, key, skip, onProgress, onJoin } = input
  const report = (phase: PullProgress["phase"], done = 0, total = 0, label?: string) =>
    onProgress?.({ phase, done, total, label })

  report("connecting")
  const device = await PocketDevice.connect(input.device.id, input.device.name)
  const lines = new LineInbox()
  const offLine = device.onLine((line) => lines.push(line))
  const heartbeat = setInterval(() => void device.command("APP&WPING").catch(() => {}), WPING_INTERVAL)
  const buffered: { file: PocketRecording; uri: string }[] = []
  let apUp = false
  try {
    await device.command(`APP&SK&${key}`)
    const auth = await lines.next((l) => l.startsWith("MCU&SK&"), 10_000, "auth")
    if (!auth.startsWith("MCU&SK&OK")) throw new Error(`${input.device.name}: the recorder rejected the session key`)

    await device.command("APP&FW")
    const firmware = await lines
      .next((l) => l.startsWith("MCU&FW&"), 8_000, "firmware")
      .then((r) => r.split("&")[2])
      .catch(() => undefined)

    report("listing")
    const recordings: PocketRecording[] = []
    for (const date of await listDates(lines, device)) recordings.push(...(await listRecordings(lines, device, date)))
    const queue = recordings
      .filter((r) => !skip.has(`${r.date}/${r.name}`))
      .sort((a, b) => `${a.date}/${a.name}`.localeCompare(`${b.date}/${b.name}`))
    if (!queue.length) return { firmware, shipped: [], skipped: 0 }

    const perSession = filesPerApSession(firmware)
    let served = perSession // the first file always rides a fresh AP
    let attempt = 0
    report("waiting-wifi", 0, queue.length)
    for (const [index, recording] of queue.entries()) {
      if (served >= perSession) {
        served = 0
        apUp = false
        await bringUpAp(lines, device, onJoin, ++attempt, true)
        apUp = true
      } else if (attempt === 0) {
        await bringUpAp(lines, device, onJoin, ++attempt, false)
        apUp = true
      }
      report("downloading", index, queue.length, `${recording.date} ${recording.name}`)
      const uri = `${FileSystem.cacheDirectory}quick/${recording.date}_${recording.name}.mp3`
      await transferOne(lines, device, recording, uri)
      buffered.push({ file: recording, uri })
      served++
    }

    await device.command("APP&WIFIC").catch(() => {})
    apUp = false
    await device.close()

    report("uploading", 0, buffered.length)
    await waitReachable(client)
    const shipped: PocketRecording[] = []
    for (const [index, entry] of buffered.entries()) {
      report("uploading", index, buffered.length, `${entry.file.date} ${entry.file.name}`)
      const audioPath = await client.fsWrite(directory, `voice/pocket/${entry.file.date}/${entry.file.name}.mp3`, await readBytes(entry.uri))
      await client.voiceTranscribe({
        audioPath,
        recordingId: `${entry.file.date}_${entry.file.name}`,
        device: input.device.name,
        duration: entry.file.seconds,
      })
      await FileSystem.deleteAsync(entry.uri, { idempotent: true }).catch(() => {})
      shipped.push(entry.file)
    }
    report("done", queue.length, queue.length)
    return { firmware, shipped, skipped: recordings.length - queue.length - shipped.length }
  } catch (e) {
    // Files already streamed to the phone survive the failure; say so rather than
    // pretending the transfer was a total loss (their buffers are cleaned next run).
    if (buffered.length) throw new Error(`${(e as Error).message} (${buffered.length} file(s) already streamed to the phone.)`)
    throw e
  } finally {
    clearInterval(heartbeat)
    if (apUp) await device.command("APP&WIFIC").catch(() => {})
    offLine()
    await device.close().catch(() => {})
  }
}

// Raise the AP and wait for the phone to join it: WIFIO, then the credentials,
// then poll WIFIS once a second until the device says a client is in (WIFIS=1).
// On restart the AP goes down and comes back; iOS rejoins the remembered network
// by itself, so the only user action is on the very first join.
async function bringUpAp(
  lines: LineInbox,
  device: PocketDevice,
  onJoin: ((n: { ssid: string; password: string; attempt: number }) => void) | undefined,
  attempt: number,
  restart: boolean,
) {
  const waits = restart ? AP_RESTART_WAITS : [0]
  for (const wait of waits) {
    if (restart) {
      await device.command("APP&WIFIC").catch(() => {})
      await sleep(wait)
    }
    await device.command("APP&WIFIO")
    const raised = await lines.next((l) => l.startsWith("MCU&WIFIO"), 10_000, "APP&WIFIO").catch(() => undefined)
    if (raised === undefined) {
      if (!restart || wait === waits[waits.length - 1]) throw new Error("the recorder did not raise its Wi-Fi access point")
      continue
    }
    await device.command("APP&WIFI")
    const creds = await lines
      .next((l) => l.startsWith("MCU&WIFI&"), 8_000, "credentials")
      .catch(() => undefined)
    const parts = creds?.split("&") ?? []
    const ssid = parts[2]
    const password = parts[3]
    if (!ssid || !password) throw new Error("the recorder did not report its Wi-Fi credentials")
    onJoin?.({ ssid, password, attempt })
    const poll = setInterval(() => void device.command("APP&WIFIS").catch(() => {}), WIFIS_POLL_INTERVAL)
    try {
      await lines.next((l) => l.startsWith("MCU&WIFIS&1"), JOIN_TIMEOUT, "Wi-Fi join")
    } catch {
      throw new Error(`Join "${ssid}" in the Wi-Fi settings (password ${password}) and keep this screen open`)
    } finally {
      clearInterval(poll)
    }
    return
  }
}

// Stream one file: open the transfer socket FIRST (APP&U&WIFI with no connection
// open hangs the device), stage the file over BLE, switch it to Wi-Fi 0.3 s in,
// and read exactly <size> bytes plus the trailer into the phone's cache.
async function transferOne(lines: LineInbox, device: PocketDevice, recording: PocketRecording, uri: string) {
  const sock = await openSocket()
  try {
    await device.command(`APP&U&${recording.date}&${recording.name}`)
    const sizeLine = await lines.next((l) => l.startsWith("MCU&U&"), 15_000, "APP&U&")
    const size = Number(sizeLine.split("&")[2])
    if (!Number.isFinite(size) || size <= 0) throw new Error(`${recording.name}: the recorder did not announce a file size`)
    await sleep(SWITCH_DELAY)
    await device.command("APP&U&WIFI")
    await receive(sock, size, uri)
    const ended = await lines.next((l) => l.startsWith("MCU&OFF"), 10_000, "MCU&OFF").catch(() => undefined)
    if (ended === undefined) throw new Error(`${recording.name}: the recorder never reported the end of the transfer`)
  } finally {
    sock.destroy()
  }
}

function openSocket(): Promise<TcpSocket.Socket> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + SOCKET_RETRY_WAIT
    // The device refuses new connections for 1.5-3.5 s after each one closes.
    const attempt = () => {
      const sock = TcpSocket.createConnection({ host: AP_HOST, port: AP_PORT, connectTimeout: 3_000 }, () => {})
      const retry = () => {
        sock.destroy()
        if (Date.now() >= deadline) reject(new Error("the recorder's transfer socket never accepted a connection"))
        else setTimeout(attempt, 500)
      }
      sock.once("connect", () => {
        sock.removeListener("error", retry)
        resolve(sock)
      })
      sock.once("error", retry)
      sock.once("timeout", retry)
    }
    attempt()
  })
}

// Read exactly `size` bytes plus the 10-byte trailer from the socket. Chunks
// accumulate and land in the cache file in one write — SDK 58's legacy FS has no
// append-session, and whole-file memory is exactly what the BLE pull already
// costs, so this is no worse, and the disk copy lets the RAM go before uploads.
async function receive(sock: TcpSocket.Socket, size: number, uri: string) {
  await FileSystem.makeDirectoryAsync(`${FileSystem.cacheDirectory}quick`, { intermediates: true }).catch(() => {})
  await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
  const chunks: Uint8Array[] = []
  let received = 0
  let trailer = new Uint8Array(0)
  const started = Date.now()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let idle: ReturnType<typeof setTimeout> | undefined
    const settle = (body: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(idle)
      sock.removeListener("data", onData)
      sock.removeListener("close", onClose)
      sock.removeListener("error", onError)
      body()
    }
    const arm = () => {
      clearTimeout(idle)
      const budget = transferBudget(size) - (Date.now() - started)
      if (budget <= 0) return settle(() => reject(new Error(`the transfer overran its time budget at ${received} of ${size} bytes`)))
      idle = setTimeout(() => settle(() => reject(new Error(
        received === 0
          ? "the recorder sent nothing over Wi-Fi"
          : `the transfer stalled at ${received} of ${size} bytes`,
      ))), received === 0 ? FIRST_BYTE_TIMEOUT : Math.min(IDLE_TIMEOUT, budget))
    }
    const checkDone = () => {
      if (received >= size && trailer.length >= END_MARKER.length) {
        const ok = END_MARKER.every((b, i) => trailer[i] === b)
        // A missing trailer is reported but does not fail a complete file
        // (pocket-libre parity); a mismatch after complete data is a real lie.
        settle(() => (ok ? resolve() : reject(new Error(`${size} bytes arrived without the expected end marker`))))
      }
    }
    const onData = (chunk: Uint8Array | ArrayBuffer | string) => {
      arm()
      const bytes = chunkToBytes(chunk)
      if (received < size) {
        const body = bytes.subarray(0, size - received)
        const extra = bytes.subarray(size - received)
        if (body.length) chunks.push(body)
        received += body.length
        if (extra.length) trailer = concat(trailer, extra)
      } else {
        trailer = concat(trailer, bytes)
      }
      checkDone()
    }
    const onClose = () =>
      received >= size
        ? // A close can race the trailer by a hair; accept it with what arrived.
          settle(() => resolve())
        : settle(() => reject(new Error(`the recorder closed the connection at ${received} of ${size} bytes`)))
    const onError = () =>
      settle(() => reject(new Error(received === 0 ? "the transfer connection broke before any data arrived" : `the transfer broke at ${received} of ${size} bytes`)))
    sock.on("data", onData)
    sock.once("close", onClose)
    sock.once("error", onError)
    arm()
  })
  const file = join(chunks)
  chunks.length = 0
  await FileSystem.writeAsStringAsync(uri, toBase64(file), { encoding: FileSystem.EncodingType.Base64 })
}

function join(chunks: Uint8Array[]) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

// react-native-tcp-socket types data as Buffer, but Hermes ships none; the glue
// hands over a base64 string or an ArrayBuffer depending on the platform.
function chunkToBytes(chunk: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof chunk === "string") return fromBase64(chunk)
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
  return chunk
}

function fromBase64(base64: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function toBase64(bytes: Uint8Array) {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 8192) {
    const slice = bytes.subarray(i, i + 8192)
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

async function readBytes(uri: string) {
  const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 })
  return fromBase64(base64)
}

// After the AP drops, iOS rejoin of the home network and the tunnel rebuild are
// both automatic but not instant; shipping waits for the host to answer again.
async function waitReachable(client: Client) {
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      await client.projects()
      return
    } catch {
      if (Date.now() > deadline)
        throw new Error("the host is unreachable after leaving the recorder's Wi-Fi — check the phone is back on your network")
      await sleep(2_000)
    }
  }
}
