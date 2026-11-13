export * as TranscribeTool from "./transcribe.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { basename } from "path"
import { ToolFailure } from "@opencode/ai/effect"
import { Effect, Schema } from "effect"
import { Database } from "../../database/database.js"
import { FileAccess } from "../../file-access.js"
import { SessionBlob } from "../../session/blob.js"
import { Transcribe } from "../../transcribe.js"

export const name = "transcribe"

const MEDIA_REF = /^media:([0-9a-f]{64})$/

const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      'Audio file to transcribe: a path (absolute or relative to the project) or a "media:<hash>" reference from a message attachment, e.g. a voice memo the user shared',
  }),
  language: Schema.String.pipe(Schema.optional).annotate({
    description: "ISO language code when known; otherwise the transcriber detects it",
  }),
})

const Segment = Schema.Struct({
  start: Schema.Finite,
  end: Schema.Finite,
  speaker: Schema.String.pipe(Schema.optional),
  text: Schema.String,
})

const Output = Schema.Struct({
  text: Schema.String,
  segments: Schema.Array(Segment).pipe(Schema.optional),
  language: Schema.String.pipe(Schema.optional),
  durationSeconds: Schema.Finite.pipe(Schema.optional),
})

const stamp = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`

// The diarizer emits 0-based cluster indexes as strings; render those as 1-based "Speaker N".
// A name (an enrolled voiceprint match) passes through unchanged.
const label = (speaker: string | undefined) =>
  speaker === undefined || speaker === "" ? undefined : /^\d+$/.test(speaker) ? `Speaker ${Number(speaker) + 1}` : speaker

/** A diarized recording reads better as speaker turns than as one monologue; single voices stay plain. */
const modelContent = (source: string, audio: Transcribe.Audio) => {
  const header = `Transcribed ${source}${audio.durationSeconds === undefined ? "" : `, ${Math.round(audio.durationSeconds)}s`}${audio.language === undefined ? "" : `, ${audio.language}`}`
  const segments = audio.segments ?? []
  if (segments.length < 2) return `${header}\n\n${audio.text}`
  const speakers = new Set(segments.map((segment) => label(segment.speaker)))
  if (speakers.size < 2) return `${header}\n\n${audio.text}`
  const turns: string[] = []
  for (const segment of segments) {
    const name = label(segment.speaker)
    const previous = turns[turns.length - 1]
    const text = segment.text.trim()
    if (name !== undefined && !(previous !== undefined && previous.startsWith(`${name}: `))) turns.push(`${name}: ${text}`)
    else if (previous !== undefined) turns[turns.length - 1] = `${previous} ${text}`
    else turns.push(`[${stamp(segment.start)}] ${text}`)
  }
  return `${header}\n\n${turns.join("\n\n")}`
}

const failure = (message: string) => new ToolFailure({ message })

// The tool output is the transcript fact for the model; per-token confidence stays server-side.
const toOutput = (audio: Transcribe.Audio) => ({
  text: audio.text,
  ...(audio.segments === undefined
    ? {}
    : { segments: audio.segments.map((segment) => ({ start: segment.start, end: segment.end, text: segment.text, ...(segment.speaker === undefined ? {} : { speaker: segment.speaker }) })) }),
  ...(audio.language === undefined ? {} : { language: audio.language }),
  ...(audio.durationSeconds === undefined ? {} : { durationSeconds: audio.durationSeconds }),
})

export const Plugin = {
  id: "opencode.tool.transcribe",
  effect: Effect.fn("TranscribeTool.Plugin")(function* (ctx: Context) {
    const transcribe = yield* Transcribe.Service
    const access = yield* FileAccess.Service
    const { db } = yield* Database.Service

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name,
          options: { codemode: false },
          description:
            "Transcribe an audio recording with the server's local whisper: any audio file on the server (a project path or absolute path) or a media:<hash> reference from a message attachment, such as a voice memo the user forwarded from another app. Long recordings arrive diarized, with segments labeled by speaker — enrolled people by name — so the transcript reads as speaker turns. This only produces text; nothing is stored or delivered elsewhere. To act on a note (summary, todos), use the todo tool and the usual file tools.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const ref = MEDIA_REF.exec(input.path.trim())

              if (ref === null) {
                const target = yield* access.authorizeRead(input.path, context)
                return yield* transcribe
                  .file({ path: target.absolute, ...(input.language === undefined ? {} : { language: input.language }) })
                  .pipe(
                    Effect.map((audio) => ({
                      output: toOutput(audio),
                      content: modelContent(basename(target.resource), audio),
                    })),
                  )
              }

              const blob = yield* SessionBlob.read(db, ref[1]!)

              if (blob === undefined)
                return yield* failure(
                  "That media reference is not stored (yet) by this server, or nothing references it anymore. Ask the user to attach the audio to this session.",
                )

              return yield* transcribe
                .bytes({ data: blob.data, ...(input.language === undefined ? {} : { language: input.language }) })
                .pipe(
                  Effect.map((audio) => ({
                    output: toOutput(audio),
                    content: modelContent(`media:${ref[1]!.slice(0, 12)}…`, audio),
                  })),
                )
            }).pipe(
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                if (error instanceof Transcribe.UnavailableError)
                  return new ToolFailure({
                    message: `Transcription is unavailable: ${error.message}. Check that the local whisper endpoint configured under experimental.voice.transcribe is running.`,
                  })
                if (error instanceof Transcribe.RejectedError)
                  return new ToolFailure({ message: `The transcriber refused this audio: ${error.message}` })
                return new ToolFailure({ message: `Could not transcribe ${input.path}` })
              }),
            ),
        })
      })
      .pipe(Effect.orDie)
  }),
}
