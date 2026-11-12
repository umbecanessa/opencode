import { Config } from "@opencode/core/config"
import { Generate } from "@opencode/core/generate"
import { Job } from "@opencode/core/job"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Memory } from "@opencode/core/memory/index"
import { Session } from "@opencode/core/session"
import { AbsolutePath } from "@opencode/core/schema"
import { Transcribe } from "@opencode/core/transcribe"
import { Voice } from "@opencode/core/voice"
import { ConflictError, InvalidRequestError, ServiceUnavailableError } from "@opencode/protocol/errors"
import type { VoiceIngestInput } from "@opencode/protocol/groups/voice"
import { SessionMessage } from "@opencode/schema/session-message"
import { Global } from "@opencode/util/global"
import { createHash } from "node:crypto"
import { readdir, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { Effect, Option, Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { awaitPlugins, locationErrors } from "../location"
import { missingSession } from "./session-error"

/** Fixed-ID holding session for ingested voice notes; Session.create adopts the existing row on reuse. */
const VoiceInboxSessionID = Session.ID.make("ses_voice_inbox")

/** Shipped mp3s older than this are pruned opportunistically during transcribe jobs. */
const RETENTION_DAYS = 30

const rememberUnavailable = () =>
  new ServiceUnavailableError({ message: "Memory is unavailable for that project", service: "memory" })

const Enrichment = Schema.Struct({
  summary: Schema.optional(Schema.String),
  todos: Schema.optional(Schema.Array(Schema.String)),
  project: Schema.optional(Schema.String),
})
const decodeEnrichment = Schema.decodeUnknownOption(Schema.fromJsonString(Enrichment))

export const VoiceHandler = HttpApiBuilder.group(Api, "server.voice", (handlers) =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    const locations = yield* LocationServiceMap.Service
    const session = yield* Session.Service
    const jobs = yield* Job.Service
    const services = locations.get(Location.Ref.make({ directory: AbsolutePath.make(global.config) }))
    // A pending card the user can still triage; already-delivered ones are intentionally out of scope.
    const pendingVoiceNote = Effect.fn("voice.pendingVoiceNote")(function* (itemId: SessionMessage.ID) {
      const inbox = yield* session.inbox(VoiceInboxSessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
      const item = inbox.find((entry) => entry.id === itemId && entry.type === "synthetic")
      if (item === undefined || item.type !== "synthetic")
        return yield* new InvalidRequestError({ message: `No pending voice note with id ${itemId}` })
      return item
    })
    // Consume after a successful copy or memory write; a row already promoted or delivered has
    // nothing pending left, which is the same end state this call is trying to reach.
    const consumePendingNote = Effect.fn("voice.consumePendingNote")(function* (itemId: SessionMessage.ID) {
      yield* session
        .cancelInbox({ sessionID: VoiceInboxSessionID, inboxID: itemId })
        .pipe(Effect.catch(() => Effect.void))
    })
    return handlers
      .handle(
        "voice.models",
        Effect.fn("server.voice.models")(
          function* () {
            yield* awaitPlugins
            const voice = yield* Voice.Service
            return { data: yield* voice.models() }
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "voice.session",
        Effect.fn("server.voice.session")(
          function* (request) {
            yield* awaitPlugins
            const voice = yield* Voice.Service
            const transport = yield* voice
              .session(request.payload)
              .pipe(
                Effect.mapError((error) =>
                  error._tag === "Voice.InvalidRequestError"
                    ? new InvalidRequestError({ message: error.message })
                    : new ServiceUnavailableError({ message: error.message, service: error.service }),
                ),
              )
            return { data: { transport } }
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "voice.ingest",
        Effect.fn("server.voice.ingest")(
          function* (request) {
            const payload = request.payload
            const sessionID = payload.sessionID ?? VoiceInboxSessionID
            if (payload.sessionID === undefined) {
              // Adoption is idempotent: the first ingest creates the Voice Inbox, later ones return the row.
              yield* session
                .create({
                  id: VoiceInboxSessionID,
                  title: "Voice Inbox",
                  location: Location.Ref.make({ directory: AbsolutePath.make(global.config) }),
                })
                .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
            }
            const data = yield* session
              .synthetic({
                sessionID,
                id: voiceItemID(sessionID, payload),
                text: ingestText(payload),
                description: ingestDescription(payload),
                metadata: ingestMetadata(payload),
                delivery: payload.delivery ?? "queue",
                resume: false,
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", missingSession),
                Effect.catchTag("Session.SyntheticConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Synthetic input ID conflicts with an existing durable record: ${error.inputID}`,
                      resource: error.inputID,
                    }),
                  ),
                ),
                locationErrors,
              )
            return { data }
          },
          locationErrors,
        ),
      )
      .handle(
        "voice.transcribe",
        Effect.fn("server.voice.transcribe")(
          function* (request) {
            const payload = request.payload
            const config = yield* Config.Service
            const generate = yield* Generate.Service
            const transcribe = yield* Transcribe.Service
            if (Config.latest(yield* config.entries(), "experimental")?.voice === false)
              return yield* new ServiceUnavailableError({ message: "Voice transcription is disabled by config", service: "voice" })
            const sessionID = payload.sessionID ?? VoiceInboxSessionID
            if (payload.sessionID === undefined) {
              // Adoption is idempotent: the first transcribe creates the Voice Inbox, later ones return the row.
              yield* session
                .create({
                  id: VoiceInboxSessionID,
                  title: "Voice Inbox",
                  location: Location.Ref.make({ directory: AbsolutePath.make(global.config) }),
                })
                .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
            } else {
              yield* session
                .get(payload.sessionID)
                .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
            }
            const info = yield* jobs.start({
              id: `voice_${payload.recordingId ?? payload.itemId ?? SessionMessage.ID.create()}`,
              type: "voice.transcribe",
              title: `Transcribe ${payload.recordingId ?? payload.audioPath}`,
              metadata: {
                audioPath: payload.audioPath,
                ...(payload.recordingId === undefined ? {} : { recordingId: payload.recordingId }),
              },
              run: Effect.gen(function* () {
                // Transcribe reads the absolute path fs.write returned; recordings are minutes of MP3, so one read is fine.
                const transcribed = yield* transcribe.file({
                  path: payload.audioPath,
                  ...(payload.language === undefined ? {} : { language: payload.language }),
                })
                // Whisper hallucinates confident text over near-silence; a segment that claims
                // speech past the end of the file (observed: 27.1s on a 9.1s clip) is that tell.
                const silent = isSilenceHallucination(transcribed, payload.duration)
                if (silent)
                  yield* Effect.logWarning("voice clip produced no real speech; card gated", {
                    audioPath: payload.audioPath,
                    duration: payload.duration,
                  })
                // Enrichment is best-effort: a missing or misbehaving chat model must not lose the transcript.
                const enrichment = silent
                  ? undefined
                  : yield* generate
                      .text({ prompt: enrichPrompt(transcribed.text) })
                      .pipe(
                        Effect.flatMap(parseEnrichment),
                        Effect.tapError((error) =>
                          Effect.logWarning("voice enrichment failed", { reason: error.message, audioPath: payload.audioPath }),
                        ),
                        Effect.catch(() => Effect.succeed(undefined)),
                      )
                const note = {
                  transcript: transcribed.text,
                  title: payload.title,
                  summary: silent ? "No speech detected — the clip was probably silent." : enrichment?.summary,
                  todos: enrichment?.todos,
                  segments: transcribed.segments,
                  suggestedProject: enrichment?.project,
                  device: payload.device,
                  recordingId: payload.recordingId,
                  audioPath: payload.audioPath,
                  recordedAt: payload.recordedAt,
                  duration: payload.duration,
                }
                yield* session.synthetic({
                  sessionID,
                  id: voiceItemID(sessionID, payload),
                  text: ingestText(note),
                  description: ingestDescription(note),
                  metadata: ingestMetadata(note),
                  delivery: payload.delivery ?? "queue",
                  resume: false,
                })
                // Opportunistic retention: prune date-folders older than 30 days under this
                // recording's own voice/pocket root, so shipped mp3s expire without a daemon.
                yield* purgeExpiredRecordings(payload.audioPath)
                return enrichment?.summary ?? transcribed.text.slice(0, 200)
              }),
            })
            return { data: { jobID: info.id, sessionID } }
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "voice.accept",
        Effect.fn("server.voice.accept")(
          function* (request) {
            const item = yield* pendingVoiceNote(request.payload.itemId)
            yield* session
              .get(request.payload.sessionID)
              .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
            // Re-accept into the same session is idempotent: the derived ID matches the
            // natural (session, recording) derivation, so Session ignores the retry.
            const moved = yield* session
              .synthetic({
                sessionID: request.payload.sessionID,
                id: derivedID(request.payload.sessionID, noteKey(item)),
                text: item.payload.text,
                ...(item.payload.description === undefined ? {} : { description: item.payload.description }),
                ...(item.payload.metadata === undefined ? {} : { metadata: item.payload.metadata }),
                delivery: request.payload.delivery ?? "queue",
                resume: false,
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", missingSession),
                Effect.catchTag("Session.SyntheticConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Synthetic input ID conflicts with an existing durable record: ${error.inputID}`,
                      resource: error.inputID,
                    }),
                  ),
                ),
                locationErrors,
              )
            yield* consumePendingNote(request.payload.itemId)
            return { data: moved }
          },
          locationErrors,
        ),
      )
      .handle(
        "voice.remember",
        Effect.fn("server.voice.remember")(
          function* (request) {
            const item = yield* pendingVoiceNote(request.payload.itemId)
            const metadata = (item.payload.metadata ?? {}) as Record<string, unknown>
            const title = typeof metadata.title === "string" && metadata.title !== "" ? metadata.title : `Voice note ${noteKey(item)}`
            const summary = typeof metadata.summary === "string" ? metadata.summary : undefined
            const audioPath = typeof metadata.audioPath === "string" ? metadata.audioPath : undefined
            const text = [
              summary && `Summary: ${summary}`,
              `Transcript:\n${item.payload.text}`,
              audioPath && `Audio: ${audioPath}`,
            ]
              .filter((section): section is string => Boolean(section))
              .join("\n\n")
            // Memory is location-scoped: the note belongs to the graph of the project that
            // holds the recording, which is the directory the phone shipped files into.
            const ref = Location.Ref.make({ directory: AbsolutePath.make(request.payload.directory ?? global.config) })
            yield* Effect
              .gen(function* () {
                const memory = yield* Memory.Service
                yield* memory.remember({ kind: "note", title, text, source: "capture", sessionID: String(VoiceInboxSessionID) })
              })
              .pipe(
                Effect.provide(locations.get(ref)),
                // Memory is a plugin service: an unconfigured or failing graph must surface as a
                // clean dependency error, never as a handler defect or an undeclared error type.
                Effect.catch(() => Effect.fail(rememberUnavailable())),
                Effect.catchDefect(() => Effect.fail(rememberUnavailable())),
              )
            yield* consumePendingNote(request.payload.itemId)
            return { data: { remembered: true } }
          },
          locationErrors,
        ),
      )
  }),
)

/** Stable per-session ID for a note key; the same formula across ingest, transcribe, and accept so retried routes collide into idempotent admission. */
function derivedID(sessionID: Session.ID, key: string) {
  return SessionMessage.ID.make(`msg_${createHash("sha256").update(`${sessionID}/${key}`).digest("hex").slice(0, 24)}`)
}

/** The identity a voice card carries across routes: its recording when known, else its pending item id. */
function noteKey(item: { readonly id: SessionMessage.ID; readonly payload?: { readonly metadata?: Record<string, unknown> } }) {
  const recordingId = item.payload?.metadata?.recordingId
  return typeof recordingId === "string" && recordingId !== "" ? recordingId : item.id
}

/**
 * Stable synthetic input ID. Without an explicit itemId, one is derived from
 * (session, recording): re-pulling and re-shipping the same recording then hits
 * Session's idempotent admission path (first admission wins, retries are ignored)
 * instead of minting a duplicate card, while the same recording admitted to a
 * different session still gets a distinct ID.
 */
function voiceItemID(sessionID: Session.ID, payload: { readonly itemId?: SessionMessage.ID; readonly recordingId?: string }) {
  if (payload.itemId !== undefined) return payload.itemId
  if (payload.recordingId === undefined) return undefined
  return derivedID(sessionID, payload.recordingId)
}

/** Whisper produces confident garbage over near-silence; a segment claiming speech past the file's end (observed: 27.1s on a 9.1s clip) is the tell. Empty text is its quiet cousin. */
function isSilenceHallucination(audio: Transcribe.Audio, duration?: number) {
  if (audio.text.trim() === "") return true
  if (duration === undefined) return false
  return (audio.segments ?? []).some((segment) => segment.end > duration + 2)
}

/** Models wrap JSON in fences or prose; only the object itself is interesting. */
function parseEnrichment(raw: string): Effect.Effect<Schema.Schema.Type<typeof Enrichment>, Error> {
  const parsed = decodeEnrichment(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1))
  if (Option.isSome(parsed)) return Effect.succeed(parsed.value)
  return Effect.fail(new Error(`expected an enrichment JSON object, got: ${raw.slice(0, 160)}`))
}

/** fs.write lands recordings at <root>/voice/pocket/<YYYY-MM-DD>/file.mp3; prune date folders past retention so shipped mp3s expire without a daemon. */
const purgeExpiredRecordings = Effect.fn("voice.purgeExpiredRecordings")(function* (audioPath: string) {
  const dateDir = dirname(audioPath)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(basename(dateDir))) return
  const pocketRoot = dirname(dateDir)
  const entries = yield* Effect
    .tryPromise(() => readdir(pocketRoot, { withFileTypes: true }))
    .pipe(Effect.catch(() => Effect.succeed([] as readonly { name: string; isDirectory(): boolean }[])))
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10)
  yield* Effect.forEach(
    entries.filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name) && entry.name < cutoff),
    (entry) => Effect.tryPromise(() => rm(join(pocketRoot, entry.name), { recursive: true, force: true })).pipe(Effect.ignore),
    { discard: true },
  )
})

function enrichPrompt(transcript: string) {
  return [
    "You enrich voice-note transcripts for a personal knowledge inbox.",
    "Reply with only a JSON object, no prose, with optional keys:",
    '"summary": one or two sentences of what was said;',
    '"todos": array of imperative action items explicitly mentioned (omit if none);',
    '"project": short lowercase-hyphenated project name this note most belongs to (omit if unclear).',
    "Transcript:",
    transcript.slice(0, 8000),
  ].join("\n")
}

function ingestDescription(payload: VoiceIngestInput) {
  if (payload.title) return payload.title
  if (payload.summary) return `${payload.summary.slice(0, 140)}${payload.summary.length > 140 ? "…" : ""}`
  return "Voice recording"
}

function ingestMetadata(payload: VoiceIngestInput) {
  return Object.fromEntries(
    Object.entries({
      source: "voice",
      title: payload.title,
      summary: payload.summary,
      todos: payload.todos,
      segments: payload.segments,
      suggestedProject: payload.suggestedProject,
      device: payload.device,
      recordingId: payload.recordingId,
      audioPath: payload.audioPath,
      recordedAt: payload.recordedAt,
      duration: payload.duration,
    }).filter(([, value]) => value !== undefined),
  )
}

function ingestText(payload: VoiceIngestInput) {
  const header = [
    payload.title ? `Voice recording: ${payload.title}` : "Voice recording",
    payload.device && `Device: ${payload.device}`,
    payload.recordedAt !== undefined && `Recorded: ${new Date(payload.recordedAt).toISOString()}`,
    payload.duration !== undefined && `Duration: ${Math.round(payload.duration)}s`,
    payload.suggestedProject && `Suggested project: ${payload.suggestedProject}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
  return [
    header,
    payload.summary && `Summary:\n${payload.summary}`,
    `Transcript:\n${payload.transcript}`,
    payload.segments?.length &&
      `Segments:\n${payload.segments
        .map((segment) => `[${stamp(segment.start)}]${segment.speaker ? ` (${segment.speaker})` : ""} ${segment.text}`)
        .join("\n")}`,
    payload.todos?.length && `Todos:\n${payload.todos.map((todo) => `- ${todo}`).join("\n")}`,
  ]
    .filter((section): section is string => Boolean(section))
    .join("\n\n")
}

const stamp = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`
