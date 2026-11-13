export * as Transcribe from "./transcribe.js"

import { ai, Media, TranscriptionClient } from "@opencode/ai/effect"
import { RequestExecutor } from "@opencode/ai/route"
import { configure } from "@opencode/ai/providers/openai"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Context, Effect, Layer, Schema } from "effect"
import { Config } from "./config.js"
import { requestExecutor } from "./effect/app-node-platform.js"

export interface Segment {
  readonly start: number
  readonly end: number
  readonly text: string
  readonly speaker?: string
  readonly avgLogprob?: number
}

export interface Audio {
  readonly text: string
  readonly segments?: readonly Segment[]
  readonly language?: string
  /** Decoded audio length as the transcriber itself reports it. */
  readonly durationSeconds?: number
}

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("Transcribe.UnavailableError", {
  message: Schema.String,
}) {}

/** The transcriber understood the request and refused it (e.g. audio too quiet to enroll). */
export class RejectedError extends Schema.TaggedError<RejectedError>()("Transcribe.RejectedError", {
  message: Schema.String,
}) {}

export type Error = UnavailableError | RejectedError

export interface Speaker {
  readonly name: string
  readonly created?: number
  readonly source?: string
}

export interface Interface {
  /** Transcribe an audio file at an absolute path (as returned by `fs.write`) with the configured local whisper endpoint. */
  readonly file: (input: { readonly path: string; readonly language?: string }) => Effect.Effect<Audio, Error>
  /** Named voiceprints stored on the transcriber host (the local whisper wrapper's identity store). */
  readonly speakers: () => Effect.Effect<readonly Speaker[], Error>
  /** Build a voiceprint for `name` from an audio file; re-enrolling a name replaces it. */
  readonly enroll: (input: {
    readonly name: string
    readonly path: string
    readonly ranges?: readonly (readonly [number, number])[]
    readonly source?: string
  }) => Effect.Effect<readonly Speaker[], Error>
  /** Delete a voiceprint; `removed` is false when the name was never enrolled. */
  readonly forget: (name: string) => Effect.Effect<{ readonly removed: boolean; readonly speakers: readonly Speaker[] }, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Transcribe") {}

// Whisper.cpp's bundled `server` example listens there; faster-whisper's OpenAI mode and hosted
// OpenAI are reachable through `experimental.voice.transcribe.url` without further setup.
const DEFAULT_URL = "http://127.0.0.1:8080/v1"
const DEFAULT_MODEL = "whisper-1"

// Shape of the wrapper's /v1/voices responses (list, enroll, delete) and its error bodies.
const VoicesResponse = Schema.Struct({
  voices: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String, created: Schema.optional(Schema.Finite), source: Schema.optional(Schema.String) }))),
  removed: Schema.optional(Schema.Boolean),
  error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
})
const decodeVoicesResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(VoicesResponse))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const executor = yield* RequestExecutor.Service
    const fsutil = yield* FSUtil.Service

    const file = Effect.fn("Transcribe.file")(function* (input: { readonly path: string; readonly language?: string }) {
      // Reading here instead of in the caller keeps FSUtil a node dependency: HttpApi handlers
      // cannot ambiently require it without leaking the requirement into the route type.
      const data = yield* fsutil
        .readFile(input.path)
        .pipe(Effect.mapError((error) => new UnavailableError({ message: `Cannot read audio file: ${error.message}` })))
      const voice = Config.latest(yield* config.entries(), "experimental")?.voice
      const transcribe = typeof voice === "object" ? voice.transcribe : undefined
      // Local-first by design: `apiKey: false` skips the OPENAI_API_KEY env probe entirely,
      // which is what a LAN whisper server wants.
      const model = configure({ baseURL: transcribe?.url ?? DEFAULT_URL, apiKey: false }).transcription(transcribe?.model ?? DEFAULT_MODEL)
      const response = yield* ai.experimental.transcription
        .generate({
          model,
          audio: new Media.Asset({ source: { type: "bytes", data, mediaType: "audio/mpeg" } }),
          timestamps: "segment",
          ...(input.language === undefined ? {} : { language: input.language }),
        })
        .pipe(
          Effect.mapError((error) => new UnavailableError({ message: error.message })),
          Effect.provide(TranscriptionClient.layer),
          Effect.provideService(RequestExecutor.Service, executor),
        )
      return {
        text: response.text,
        ...(response.segments === undefined
          ? {}
          : {
              segments: response.segments.map(
                (segment): Segment => ({
                  start: segment.startSeconds,
                  end: segment.endSeconds,
                  text: segment.text,
                  ...(segment.speaker === undefined ? {} : { speaker: segment.speaker }),
                  ...(segment.avgLogprob === undefined ? {} : { avgLogprob: segment.avgLogprob }),
                }),
              ),
            }),
        ...(response.language === undefined ? {} : { language: response.language }),
        ...(response.durationSeconds === undefined ? {} : { durationSeconds: response.durationSeconds }),
      } satisfies Audio
    })

    // The named-speaker voiceprint store lives on the local whisper wrapper beside the
    // transcriber (its /v1/voices route). A hosted endpoint has no such extension and the
    // methods surface 404 as unavailable, which the UI renders as "no voiceprints here".
    const voicesURL = Effect.fnUntraced(function* () {
      const voice = Config.latest(yield* config.entries(), "experimental")?.voice
      const transcribe = typeof voice === "object" ? voice.transcribe : undefined
      return (transcribe?.url ?? DEFAULT_URL).replace(/\/+$/, "") + "/voices"
    })
    const voicesCall = Effect.fnUntraced(function* (url: string, init: RequestInit) {
      const result = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(url, init)
          return { status: response.status, text: await response.text() }
        },
        catch: (error) => new UnavailableError({ message: `Voiceprint endpoint unreachable: ${(error as Error).message}` }),
      })
      const body = yield* decodeVoicesResponse(result.text).pipe(
        Effect.mapError(() => new UnavailableError({ message: `Voiceprint endpoint returned an unrecognized response (${result.status})` })),
      )
      if (result.status >= 400)
        return yield* result.status === 400
          ? new RejectedError({ message: body.error?.message ?? "The transcriber rejected the voiceprint request" })
          : new UnavailableError({ message: body.error?.message ?? `Voiceprint endpoint failed (${result.status})` })
      return body
    })
    const speakerList = (body: Schema.Schema.Type<typeof VoicesResponse>) =>
      (body.voices ?? []).map(
        (voice): Speaker => ({
          name: voice.name,
          ...(voice.created === undefined ? {} : { created: voice.created }),
          ...(voice.source === undefined ? {} : { source: voice.source }),
        }),
      )

    const speakers = Effect.fn("Transcribe.speakers")(function* () {
      return speakerList(yield* voicesCall(yield* voicesURL(), { method: "GET" }))
    })

    const enroll = Effect.fn("Transcribe.enroll")(function* (input: {
      readonly name: string
      readonly path: string
      readonly ranges?: readonly (readonly [number, number])[]
      readonly source?: string
    }) {
      // Same reason `file` reads here: FSUtil stays a node dependency instead of leaking
      // into every HttpApi handler that touches voiceprints.
      const data = yield* fsutil
        .readFile(input.path)
        .pipe(Effect.mapError((error) => new RejectedError({ message: `Cannot read enrollment audio: ${error.message}` })))
      const form = new FormData()
      form.append("name", input.name)
      form.append("file", new Blob([data]), input.path.replace(/^.*[\\/]/, "") || "audio.bin")
      if (input.ranges !== undefined) form.append("ranges", JSON.stringify(input.ranges))
      if (input.source !== undefined) form.append("source", input.source)
      return speakerList(yield* voicesCall(yield* voicesURL(), { method: "POST", body: form }))
    })

    const forget = Effect.fn("Transcribe.forget")(function* (name: string) {
      const body = yield* voicesCall(`${yield* voicesURL()}/${encodeURIComponent(name)}`, { method: "DELETE" })
      return { removed: body.removed ?? false, speakers: speakerList(body) }
    })

    return Service.of({ file, speakers, enroll, forget })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Config.node, requestExecutor, FSUtil.node] })
