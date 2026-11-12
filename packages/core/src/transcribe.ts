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

export type Error = UnavailableError

export interface Interface {
  /** Transcribe an audio file at an absolute path (as returned by `fs.write`) with the configured local whisper endpoint. */
  readonly file: (input: { readonly path: string; readonly language?: string }) => Effect.Effect<Audio, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Transcribe") {}

// Whisper.cpp's bundled `server` example listens there; faster-whisper's OpenAI mode and hosted
// OpenAI are reachable through `experimental.voice.transcribe.url` without further setup.
const DEFAULT_URL = "http://127.0.0.1:8080/v1"
const DEFAULT_MODEL = "whisper-1"

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

    return Service.of({ file })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Config.node, requestExecutor, FSUtil.node] })
