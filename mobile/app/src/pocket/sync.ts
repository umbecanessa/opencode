import type { Client } from "../api/client"
import { PocketDevice } from "./device"

export type PocketRecording = { date: string; name: string; seconds: number }

export type PullProgress = {
  phase: "connecting" | "listing" | "downloading" | "uploading" | "done"
  done: number
  total: number
  label?: string
}

export type PullResult = {
  battery?: number
  firmware?: string
  shipped: PocketRecording[]
  skipped: number
}

// The recorder talks ASCII lines: APP& commands out, MCU& replies and events back, with the
// MP3 body streamed separately. One pull = auth, clock-sync, list, download-each, upload+transcribe.
export async function pullPocket(input: {
  client: Client
  directory: string
  device: { id: string; name: string }
  key: string
  skip: Set<string>
  onProgress?: (p: PullProgress) => void
}): Promise<PullResult> {
  const { client, directory, key, skip, onProgress } = input
  const report = (phase: PullProgress["phase"], done = 0, total = 0, label?: string) =>
    onProgress?.({ phase, done, total, label })

  report("connecting")
  const device = await PocketDevice.connect(input.device.id, input.device.name)
  const lines = new LineInbox()
  const offLine = device.onLine((line) => lines.push(line))
  try {
    await device.command(`APP&SK&${key}`)
    const auth = await lines.next((l) => l.startsWith("MCU&SK&"), 10_000, "auth")
    if (!auth.startsWith("MCU&SK&OK")) throw new Error(`${input.device.name}: the recorder rejected the session key`)

    const battery = await reply(lines, device, "APP&BAT", "MCU&BAT&", 8_000).then((r) =>
      r === undefined ? undefined : Number(r.split("&")[2]),
    )
    const firmware = await reply(lines, device, "APP&FW", "MCU&FW&", 8_000).then((r) => r?.split("&")[2])

    // Recording names come from the device clock; the vendor app keeps it on UTC, so we do too.
    const now = new Date()
    const utc = [
      now.getUTCFullYear(),
      now.getUTCMonth() + 1,
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
    ].map((n) => String(n).padStart(2, "0"))
    await device.command(`APP&T&${utc.join("")}`)

    report("listing")
    const dates = await listDates(lines, device)
    const recordings: PocketRecording[] = []
    for (const date of dates) recordings.push(...(await listRecordings(lines, device, date)))
    const queue = recordings
      .filter((r) => !skip.has(`${r.date}/${r.name}`))
      .sort((a, b) => `${a.date}/${a.name}`.localeCompare(`${b.date}/${b.name}`))

    const shipped: PocketRecording[] = []
    for (const [index, recording] of queue.entries()) {
      report("downloading", index, queue.length, `${recording.date} ${recording.name}`)
      const bytes = await download(device, lines, recording)
      report("uploading", index, queue.length, `${recording.date} ${recording.name}`)
      const audioPath = await client.fsWrite(
        directory,
        `voice/pocket/${recording.date}/${recording.name}.mp3`,
        bytes,
      )
      await client.voiceTranscribe({
        audioPath,
        recordingId: `${recording.date}_${recording.name}`,
        device: input.device.name,
        duration: recording.seconds,
        ...(recordedAt(recording) === undefined ? {} : { recordedAt: recordedAt(recording) }),
      })
      shipped.push(recording)
    }
    report("done", queue.length, queue.length)
    return { battery, firmware, shipped, skipped: recordings.length - queue.length }
  } finally {
    offLine()
    await device.close()
  }
}

class LineInbox {
  private pending: string[] = []
  private waiters: { pred: (l: string) => boolean; resolve: (l: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = []

  push(line: string) {
    // The wrapper reports a dropped link as a synthetic line so every open wait fails fast
    // instead of burning its transfer timeout on a dead connection.
    if (line.startsWith("MCU&DISCONNECT&")) {
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error("the recorder dropped the connection"))
      }
      return
    }
    const waiter = this.waiters.find((w) => w.pred(line))
    if (waiter) {
      this.waiters.splice(this.waiters.indexOf(waiter), 1)
      clearTimeout(waiter.timer)
      waiter.resolve(line)
      return
    }
    this.pending.push(line)
    if (this.pending.length > 512) this.pending.shift()
  }

  next(pred: (l: string) => boolean, timeoutMs: number, what: string): Promise<string> {
    const buffered = this.pending.find(pred)
    if (buffered !== undefined) {
      this.pending.splice(this.pending.indexOf(buffered), 1)
      return Promise.resolve(buffered)
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.reject !== reject)
        reject(new Error(`no reply for ${what}`))
      }, timeoutMs)
      this.waiters.push({ pred, resolve, reject, timer })
    })
  }

  /** Every buffered line with this prefix, in arrival order, removed from the buffer. */
  drain(prefix: string) {
    const taken: string[] = []
    this.pending = this.pending.filter((line) => {
      if (!line.startsWith(prefix)) return true
      taken.push(line)
      return false
    })
    return taken
  }
}

async function reply(lines: LineInbox, device: PocketDevice, command: string, prefix: string, timeoutMs: number) {
  await device.command(command)
  return lines.next((l) => l.startsWith(prefix), timeoutMs, command).catch(() => undefined)
}

async function listDates(lines: LineInbox, device: PocketDevice) {
  await device.command("APP&LIST_DIRS")
  await lines
    .next((l) => l.startsWith("MCU&DIRS_SUM&"), 15_000, "APP&LIST_DIRS")
    .catch(() => undefined)
  // Drain the DIRS lines that arrived before the summary; the summary only counts them.
  const dates = lines.drain("MCU&DIRS&").map((line) => line.split("&")[2])
  if (dates.length) return dates
  // A silent LIST_DIRS (older firmware): fall back to the week the vendor app probes anyway.
  return lastDays(7)
}

async function listRecordings(lines: LineInbox, device: PocketDevice, date: string): Promise<PocketRecording[]> {
  await device.command(`APP&LIST&${date}`)
  const count = await lines
    .next((l) => l.startsWith("MCU&LIST&"), 20_000, `APP&LIST&${date}`)
    .then((l) => Number(l.split("&")[2]))
    .catch(() => undefined)
  const found: PocketRecording[] = []
  for (const line of lines.drain("MCU&F&")) {
    const [, , entryDate, name, seconds] = line.split("&")
    found.push({ date: entryDate ?? date, name, seconds: Number(seconds) || 0 })
  }
  // A listing without its count line, or short of it, is incomplete rather than empty (PROTOCOL.md).
  if (count === undefined) throw new Error(`listing ${date} came back incomplete`)
  return found
}

async function download(device: PocketDevice, lines: LineInbox, recording: PocketRecording) {
  const chunks: Uint8Array[] = []
  const offAudio = device.onAudio((bytes) => chunks.push(bytes))
  try {
    await device.command(`APP&U&${recording.date}&${recording.name}`)
    const sizeLine = await lines.next((l) => l.startsWith("MCU&U&"), 15_000, "APP&U&")
    const size = Number(sizeLine.split("&")[2])
    // ~4000 B/s of audio at 32 kbps plus generous connect slack; large files scale the wait.
    const budget = Math.max(60_000, Math.ceil(size / 2000) * 1000 + 30_000)
    await lines.next((l) => l.startsWith("MCU&OFF"), budget, "MCU&OFF")
    const bytes = concat(chunks)
    if (size > 0 && bytes.length < size) throw new Error(`${recording.name}: got ${bytes.length}/${size} bytes`)
    return bytes
  } finally {
    offAudio()
    await device.command("APP&STO").catch(() => {})
  }
}

function concat(chunks: Uint8Array[]) {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function lastDays(count: number) {
  const days: string[] = []
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.now() - i * 86_400_000)
    days.push(d.toISOString().slice(0, 10))
  }
  return days
}

// Recording names carry the UTC start time (plain 14 digits, or PH + 12 for the CALL-position
// form); anything else stays undefined and the server keeps only the ingest timestamp.
function recordedAt(recording: PocketRecording) {
  const digits = recording.name.startsWith("PH") ? `20${recording.name.slice(2)}` : recording.name
  if (!/^\d{14}$/.test(digits)) return undefined
  return Date.UTC(
    Number(digits.slice(0, 4)),
    Number(digits.slice(4, 6)) - 1,
    Number(digits.slice(6, 8)),
    Number(digits.slice(8, 10)),
    Number(digits.slice(10, 12)),
    Number(digits.slice(12, 14)),
  )
}
