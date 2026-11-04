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
  .annotateMerge(
    OpenApi.annotations({
      title: "voice",
      description: "Experimental server-brokered voice session and voice ingest routes.",
    }),
  )
