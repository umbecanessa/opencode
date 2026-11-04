import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Session } from "@opencode/core/session"
import { AbsolutePath } from "@opencode/core/schema"
import { Voice } from "@opencode/core/voice"
import { ConflictError, InvalidRequestError, ServiceUnavailableError } from "@opencode/protocol/errors"
import type { VoiceIngestInput } from "@opencode/protocol/groups/voice"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { awaitPlugins, locationErrors } from "../location"
import { missingSession } from "./session-error"

/** Fixed-ID holding session for ingested voice notes; Session.create adopts the existing row on reuse. */
const VoiceInboxSessionID = Session.ID.make("ses_voice_inbox")

export const VoiceHandler = HttpApiBuilder.group(Api, "server.voice", (handlers) =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    const locations = yield* LocationServiceMap.Service
    const session = yield* Session.Service
    const services = locations.get(Location.Ref.make({ directory: AbsolutePath.make(global.config) }))
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
                id: payload.itemId,
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
  }),
)

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
