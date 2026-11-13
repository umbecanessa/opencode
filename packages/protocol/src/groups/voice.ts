import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import {
  ConflictError,
  InvalidRequestError,
  LocationNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
} from "../errors.js"

export const VoiceTransportType = Schema.Literals(["webrtc", "websocket"]).annotate({
  identifier: "VoiceTransportType",
})

export const VoiceModel = Schema.Struct({
  model: Schema.String,
  provider: Schema.String,
  transports: Schema.Array(VoiceTransportType),
  available: Schema.Boolean,
}).annotate({ identifier: "VoiceModel" })

export const VoiceWebRTCTransportInput = Schema.Struct({
  type: Schema.Literal("webrtc"),
  sdp: Schema.String,
  dcid: Schema.optional(Schema.Number),
}).annotate({ identifier: "VoiceWebRTCTransportInput" })

export const VoiceWebSocketTransportInput = Schema.Struct({
  type: Schema.Literal("websocket"),
}).annotate({ identifier: "VoiceWebSocketTransportInput" })

export const VoiceTransportInput = Schema.Union([
  VoiceWebRTCTransportInput,
  VoiceWebSocketTransportInput,
]).annotate({ identifier: "VoiceTransportInput" })

export const VoiceWebRTCTransport = Schema.Struct({
  type: Schema.Literal("webrtc"),
  sdp: Schema.String,
}).annotate({ identifier: "VoiceWebRTCTransport" })

export const VoiceWebSocketTransport = Schema.Struct({
  type: Schema.Literal("websocket"),
  url: Schema.String,
  token: Schema.String,
  expiresAt: Schema.Number,
}).annotate({ identifier: "VoiceWebSocketTransport" })

export const VoiceTransport = Schema.Union([
  VoiceWebRTCTransport,
  VoiceWebSocketTransport,
]).annotate({ identifier: "VoiceTransport" })

export interface VoiceIngestSegment extends Schema.Schema.Type<typeof VoiceIngestSegment> {}
export const VoiceIngestSegment = Schema.Struct({
  start: Schema.Finite,
  end: Schema.Finite,
  speaker: Schema.String.pipe(Schema.optional),
  text: Schema.String,
}).annotate({ identifier: "VoiceIngestSegment" })

export interface VoiceIngestInput extends Schema.Schema.Type<typeof VoiceIngestInput> {}
export const VoiceIngestInput = Schema.Struct({
  transcript: Schema.String,
  itemId: SessionMessage.ID.pipe(Schema.optional),
  sessionID: Session.ID.pipe(Schema.optional),
  title: Schema.String.pipe(Schema.optional),
  summary: Schema.String.pipe(Schema.optional),
  todos: Schema.Array(Schema.String).pipe(Schema.optional),
  segments: Schema.Array(VoiceIngestSegment).pipe(Schema.optional),
  recordedAt: Schema.Finite.pipe(Schema.optional),
  duration: Schema.Finite.pipe(Schema.optional),
  device: Schema.String.pipe(Schema.optional),
  recordingId: Schema.String.pipe(Schema.optional),
  audioPath: Schema.String.pipe(Schema.optional),
  suggestedProject: Schema.String.pipe(Schema.optional),
  delivery: SessionInbox.Delivery.pipe(Schema.optional),
}).annotate({ identifier: "VoiceIngestInput" })

export interface VoiceTranscribeInput extends Schema.Schema.Type<typeof VoiceTranscribeInput> {}
export const VoiceTranscribeInput = Schema.Struct({
  audioPath: Schema.String,
  itemId: SessionMessage.ID.pipe(Schema.optional),
  sessionID: Session.ID.pipe(Schema.optional),
  title: Schema.String.pipe(Schema.optional),
  device: Schema.String.pipe(Schema.optional),
  recordingId: Schema.String.pipe(Schema.optional),
  recordedAt: Schema.Finite.pipe(Schema.optional),
  duration: Schema.Finite.pipe(Schema.optional),
  language: Schema.String.pipe(Schema.optional),
  delivery: SessionInbox.Delivery.pipe(Schema.optional),
}).annotate({ identifier: "VoiceTranscribeInput" })

export interface VoiceDictateInput extends Schema.Schema.Type<typeof VoiceDictateInput> {}
export const VoiceDictateInput = Schema.Struct({
  /** Base64-encoded audio bytes (short dictation clip; webm/opus or wav). */
  audio: Schema.String,
  language: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "VoiceDictateInput" })

export interface VoiceAcceptInput extends Schema.Schema.Type<typeof VoiceAcceptInput> {}
export const VoiceAcceptInput = Schema.Struct({
  itemId: SessionMessage.ID,
  sessionID: Session.ID,
  delivery: SessionInbox.Delivery.pipe(Schema.optional),
}).annotate({ identifier: "VoiceAcceptInput" })

export interface VoiceRememberInput extends Schema.Schema.Type<typeof VoiceRememberInput> {}
export const VoiceRememberInput = Schema.Struct({
  itemId: SessionMessage.ID,
  directory: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "VoiceRememberInput" })

export const VoiceGroup = HttpApiGroup.make("server.voice")
  .add(
    HttpApiEndpoint.get("voice.models", "/api/experimental/voice/models", {
      success: Schema.Struct({
        data: Schema.Struct({
          models: Schema.Array(VoiceModel),
          default: Schema.optional(Schema.String),
        }),
      }).annotate({ identifier: "VoiceModelsResponse" }),
      error: [ServiceUnavailableError, LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.models",
        summary: "List voice models",
        description:
          "List supported voice models, their transports, and whether the server has a usable API key for each provider.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("voice.session", "/api/experimental/voice/session", {
      payload: Schema.Struct({
        model: Schema.String,
        session: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        transport: VoiceTransportInput,
      }),
      success: Schema.Struct({
        data: Schema.Struct({
          transport: VoiceTransport,
        }),
      }).annotate({ identifier: "VoiceSessionResponse" }),
      error: [InvalidRequestError, ServiceUnavailableError, LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.session",
        summary: "Create voice session",
        description:
          "Create a server-brokered voice session using the server's configured provider credentials and return the WebRTC SDP answer or WebSocket ephemeral token.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("voice.ingest", "/api/experimental/voice/ingest", {
      payload: VoiceIngestInput,
      success: Schema.Struct({ data: SessionInbox.Synthetic }),
      error: [InvalidRequestError, ConflictError, SessionNotFoundError, LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.ingest",
        summary: "Ingest voice recording transcript",
        description:
          "Experimental: may change without compatibility guarantees. Durably admit an externally transcribed voice recording (e.g. from a Pocket recorder) as pending synthetic session input without waking execution, creating the Voice Inbox session when no target session is given.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("voice.transcribe", "/api/experimental/voice/transcribe", {
      payload: VoiceTranscribeInput,
      success: Schema.Struct({
        data: Schema.Struct({
          jobID: Schema.String,
          sessionID: Session.ID,
        }),
      }).annotate({ identifier: "VoiceTranscribeResponse" }),
      error: [InvalidRequestError, ConflictError, SessionNotFoundError, ServiceUnavailableError, LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.transcribe",
        summary: "Transcribe uploaded voice recording",
        description:
          "Experimental: may change without compatibility guarantees. Starts a server-side job that transcribes audio previously uploaded to `audioPath` with the configured local whisper endpoint, enriches it with a summary and todos, and admits it as pending synthetic session input without waking execution. Returns immediately with the job id and the target session.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("voice.dictate", "/api/experimental/voice/dictate", {
      payload: VoiceDictateInput,
      success: Schema.Struct({
        data: Schema.Struct({
          text: Schema.String,
          language: Schema.String.pipe(Schema.optional),
          segments: Schema.Array(VoiceIngestSegment).pipe(Schema.optional),
        }),
      }).annotate({ identifier: "VoiceDictateResponse" }),
      error: [InvalidRequestError, ServiceUnavailableError, LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.dictate",
        summary: "Transcribe a dictation clip synchronously",
        description:
          "Experimental: may change without compatibility guarantees. Transcribes a short base64-encoded microphone clip with the same server-side whisper endpoint the voice recorder pipeline uses, returning the text (and segments) in the response instead of starting a background job. Nothing is stored; use voice.transcribe for long recordings that should become voice notes.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("voice.accept", "/api/experimental/voice/accept", {
      payload: VoiceAcceptInput,
      success: Schema.Struct({ data: SessionInbox.Synthetic }),
      error: [InvalidRequestError, ConflictError, SessionNotFoundError, LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.accept",
        summary: "Accept a pending voice note into a session",
        description:
          "Experimental: may change without compatibility guarantees. Moves a pending Voice Inbox note into the target session as durable synthetic input and consumes the pending inbox item. The note steers by default (delivered before the model's next step) and wakes an idle target, so the model is aware of it promptly. Like remember, it also archives the transcript as a markdown file under the target project's notes/transcripts/ folder with a memory record referencing it (best-effort), so the note survives session condensation. Concurrent retries are safe: the admitted note keeps a stable per-session identity, so only the first accept wins. Notes already consumed (delivered, accepted, or remembered) fail with 400.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("voice.remember", "/api/experimental/voice/remember", {
      payload: VoiceRememberInput,
      success: Schema.Struct({ data: Schema.Struct({ remembered: Schema.Boolean }) }),
      error: [InvalidRequestError, SessionNotFoundError, ServiceUnavailableError, LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.remember",
        summary: "Remember a pending voice note for a project",
        description:
          "Experimental: may change without compatibility guarantees. Writes a pending Voice Inbox note into the memory graph of the project at `directory` (server home project when omitted) and consumes the pending inbox item, without delivering the note to any session. The transcript itself is archived as a markdown file under the project's notes/transcripts/ folder, and the memory record references that file path so future sessions can read it even after their own context is condensed.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "voice",
      description: "Experimental server-brokered voice session and voice ingest routes.",
    }),
  )
