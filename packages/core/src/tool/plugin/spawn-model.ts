export * as SpawnModel from "./spawn-model.js"

import { Effect } from "effect"
import { Model } from "../../model.js"

/**
 * Fallback model for sessions an agent creates when neither an explicit model
 * nor an agent-configured or parent-inherited model applies: every machine in
 * the coordination fleet serves this opencodex model, so spawned work starts
 * on a known-good ref instead of whatever each server happens to default to.
 *
 * `experimental.spawn_model` overrides the constant per config, and the empty
 * string disables the fallback entirely so each server keeps its own default.
 */
export const DEFAULT = "opencodex/GX10/qwen3.8-flash-next"

/** The spawn fallback for a config value: the override, else the constant; none when disabled or unparseable. */
export const ref = (configured: string | undefined) =>
  Effect.try({
    try: () => (configured === "" ? undefined : Model.Ref.parse(configured ?? DEFAULT)),
    catch: () => new Error(`Invalid spawn_model reference: ${configured}`),
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))
