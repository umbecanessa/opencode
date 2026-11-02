export * as MemoryLocal from "./local.js"

import path from "node:path"
import { Effect } from "effect"

/** Default local model: small, fast on CPU (q8 ≈ 30 MB), strong short-text retrieval. */
export const DEFAULT_LOCAL_MODEL = "xenova/bge-small-en-v1.5"

/** Models the settings UI offers; all run through the same feature-extraction pipeline. */
export const LOCAL_MODELS = [
  { id: DEFAULT_LOCAL_MODEL, label: "BGE Small (English, 30 MB)" },
  { id: "xenova/bge-base-en-v1.5", label: "BGE Base (English, 50 MB)" },
  { id: "xenova/nomic-embed-text-v1.5", label: "Nomic Embed (8192 ctx, 120 MB)" },
] as const

export type Status =
  | { readonly state: "idle" }
  | { readonly state: "downloading"; readonly model: string; readonly percent: number }
  | { readonly state: "ready"; readonly model: string }
  | { readonly state: "failed"; readonly error: string }

// One pipeline per process, keyed by model id. The library holds native handles, so exactly one
// is live; switching models disposes the previous one. The status is observable while a download
// runs so the settings UI can show progress.
let pipeline: Promise<FeatureExtraction> | undefined
let pipelineModel: string | undefined
let status: Status = { state: "idle" }

interface FeatureExtraction {
  (texts: string[], options: { pooling: "mean"; normalize: true }): Promise<{
    tolist(): number[][]
  }>
  dispose?(): Promise<void> | void
}

function setStatus(next: Status) {
  status = next
}

/** Latest pipeline status: idle | downloading(percent) | ready | failed. Never throws. */
export function current(): Status {
  return status
}

export function known(): ReadonlyArray<{ readonly id: string; readonly label: string }> {
  return LOCAL_MODELS
}

/** Drop the loaded pipeline so the next embed re-resolves (model change or endpoint switch). */
export function reset() {
  const loaded = pipeline
  pipeline = undefined
  pipelineModel = undefined
  status = { state: "idle" }
  void loaded?.then((instance) => void instance.dispose?.()).catch(() => {})
}

function ensure(model: string, cacheDirectory: string): Promise<FeatureExtraction> {
  if (pipeline !== undefined && pipelineModel === model) return pipeline
  const loaded = (async () => {
    setStatus({ state: "downloading", model, percent: 0 })
    const transformers = await import("@huggingface/transformers")
    transformers.env.allowRemoteModels = true
    transformers.env.allowLocalModels = false
    transformers.env.cacheDir = path.join(cacheDirectory, "models")
    const instance = (await transformers.pipeline("feature-extraction", model, {
      dtype: "q8",
      progress_callback: (progress: { status?: string; progress?: unknown }) => {
        if (progress.status === "progress" && typeof progress.progress === "number")
          setStatus({ state: "downloading", model, percent: Math.min(Math.round(progress.progress), 100) })
      },
    })) as unknown as FeatureExtraction
    setStatus({ state: "ready", model })
    return instance
  })()
  // A failed load must not poison later attempts; the promise chain above stays unhandled-safe.
  loaded.catch(() => {
    if (pipeline === loaded) {
      pipeline = undefined
      pipelineModel = undefined
    }
  })
  pipeline = loaded
  pipelineModel = model
  return loaded
}

/** Mean-pooled, L2-normalized vectors, or undefined when the model cannot load or run. */
export const embed = (texts: ReadonlyArray<string>, model: string, cacheDirectory: string) =>
  Effect.tryPromise({
    try: async () => {
      const instance = await ensure(model, cacheDirectory)
      const output = await instance(texts.slice(0, 64) as string[], { pooling: "mean", normalize: true })
      return output.tolist()
    },
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  }).pipe(
    Effect.tapError((error) => Effect.sync(() => setStatus({ state: "failed", error }))),
    Effect.catch(() => Effect.succeed(undefined)),
  )
