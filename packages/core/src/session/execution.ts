export * as SessionExecution from "./execution.js"

import { Cause, Context, Effect, Exit, Layer, Option } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Job } from "../job.js"
import { Instance } from "../instance/service.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { ServerIdentity } from "../server-identity.js"
import { SessionEvent } from "./event.js"
import { SessionRunCoordinator } from "./run-coordinator.js"
import { SessionRunner } from "./runner/index.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"
import { toSessionError } from "./to-session-error.js"
import { SessionInbox } from "./inbox.js"
import { SessionWakeForward } from "./wake-forward.js"

export interface Interface {
  /** Snapshots active execution owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Checks process-local ownership, including interruption cleanup and terminal settlement. */
  readonly isActive: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Starts execution while idle or joins the active execution. */
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /**
   * Registers newly recorded work. Repeated wakeups may coalesce. When the
   * Session's durable claim names a live foreign owner, the wake is forwarded
   * there instead; otherwise this server adopts the claim under the fence.
   */
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /**
   * Interrupt active work owned by this process. Idle interruption is a no-op. Resolves once
   * the interruption is accepted; cleanup settles asynchronously in the execution fiber.
   * Returns whether an active execution was interrupted. Compose with `awaitIdle` when
   * settlement matters.
   */
  readonly interrupt: (
    sessionID: SessionSchema.ID,
    options?: {
      readonly resume?: boolean
    },
  ) => Effect.Effect<boolean>
  /** Resolves once this process owns no active execution for the Session. Returns immediately when idle and never starts work. */
  readonly awaitIdle: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

/** Routes execution from a Session ID to its selected instance's runner. */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionExecution") {}

type InterruptReason = "user" | "shutdown"

export function terminal(exit: Exit.Exit<void, SessionRunner.RunError>, reason?: InterruptReason) {
  if (Exit.isSuccess(exit)) return { type: "succeeded" as const }
  if (Cause.hasInterrupts(exit.cause)) return { type: "interrupted" as const, reason: reason ?? "shutdown" }
  return { type: "failed" as const, error: toSessionError(Cause.squash(exit.cause)) }
}

/** Process-local execution: drains run in this process using the selected instance. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const instances = yield* Instance.Service
    const bus = yield* Bus.Service
    const jobs = yield* Job.Service
    const db = (yield* Database.Service).db
    // Clustering participation is opt-in per composition: a host that
    // composes ServerIdentity.node claims under its boot identity and routes
    // wakes by ownership; one that doesn't (embedded tools, unit-test graphs)
    // keeps the single-server behaviour exactly.
    const identity = yield* Effect.serviceOption(ServerIdentity.Service)
    const wakes = yield* Effect.serviceOption(SessionWakeForward.Service)
    const reportLifecycle = <A>(sessionID: SessionSchema.ID, effect: Effect.Effect<A>) =>
      effect.pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to publish Session execution lifecycle", cause).pipe(
                Effect.annotateLogs({ sessionID }),
              ),
        ),
        Effect.asVoid,
      )
    // Write-ahead claim: starting records the durable intent that a turn is in flight, in the same
    // transaction as the started event. Terminals release it — except shutdown interruption, which
    // preserves the claim so the next server start resumes the turn. A claim that survives with no
    // terminal is the signature of a process that died without teardown (crash, SIGKILL, eviction);
    // recovery is a property of the database, never of a shutdown hook that may not run.
    // The claim carries this process's boot identity so co-mounted servers can
    // tell whose turn it is; without an identity service the stamp stays empty
    // and every consumer treats the claim as unattributed.
    const claimOnCommit = (sessionID: SessionSchema.ID) => ({
      commit: () =>
        Effect.gen(function* () {
          if (Option.isNone(identity)) return yield* store.claim(sessionID)
          const [url] = yield* identity.value.urls
          yield* store.claim(sessionID, { id: identity.value.id, ...(url === undefined ? {} : { url }) })
        }),
    })
    const releaseOnCommit = (sessionID: SessionSchema.ID) => ({
      commit: () => store.release(sessionID, Option.isSome(identity) ? identity.value.id : undefined),
    })
    const drain = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      force: boolean,
      continuation?: SessionRunner.Continuation,
      promotable: SessionInbox.Promotable = "input",
      stepped = false,
    ): Effect.fn.Return<void, SessionRunner.RunError> {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      // Step-boundary ownership: a drain continues only while this boot holds the
      // claim (or nobody stamped it). A foreign owner means another server fenced
      // its way in — this turn yields instead of racing on model spend.
      if (Option.isSome(identity)) {
        const owner = (yield* store.attribution(sessionID))?.owner
        if (owner !== undefined && owner !== identity.value.id)
          return yield* Effect.logInfo("yielding drain to fence owner", { sessionID, owner }).pipe(Effect.asVoid)
      }
      const result = yield* SessionRunner.Service.use((runner) =>
        runner.drain({ sessionID, force, continuation, promotable, stepped }),
      ).pipe(
        instances.provide(session),
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
        ),
      )
      return yield* SessionRunner.DrainResult.$match(result, {
        Complete: () => Effect.void,
        Moved: (result) => drain(sessionID, false, result.continuation, promotable, result.stepped),
        Reloaded: (result) => drain(sessionID, result.force, result.continuation, promotable, result.stepped),
      })
    })
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError, InterruptReason>({
      started: (sessionID) =>
        reportLifecycle(
          sessionID,
          bus.publish(SessionEvent.Execution.Started, { sessionID }, claimOnCommit(sessionID)),
        ),
      drain: (sessionID, force, promotable) => drain(sessionID, force, undefined, promotable),
      // One terminal observation per busy period, covering every coalesced drain.
      settled: (sessionID, exit, reason) =>
        reportLifecycle(
          sessionID,
          Effect.gen(function* () {
            const outcome = terminal(exit, reason)
            if (outcome.type === "succeeded") {
              yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID }, releaseOnCommit(sessionID))
              return
            }
            if (outcome.type === "interrupted") {
              // Deliberate stops release the claim; shutdown keeps it for restart continuity.
              if (outcome.reason !== "shutdown") yield* jobs.cancel(sessionID)
              yield* bus.publish(
                SessionEvent.Execution.Interrupted,
                { sessionID, reason: outcome.reason },
                outcome.reason === "shutdown" ? undefined : releaseOnCommit(sessionID),
              )
              return
            }
            yield* bus.publish(
              SessionEvent.Execution.Failed,
              {
                sessionID,
                error: outcome.error,
              },
              releaseOnCommit(sessionID),
            )
          }),
        ),
    })

    // Cursor-style steering: a drain parked in a foreground blocking call (a shell tool
    // waiting on Job.block) cannot observe a steer that arrives while it waits, because
    // the runner only promotes input at step boundaries and the doorbell is only read
    // after the drain returns. When a wake lands on an active drain with a pending steer,
    // release the park by moving that session's blocking work to the background: the
    // blocked call resumes with a backgrounded result that names the shell to the model,
    // and the steer is then promoted at the next safe boundary like any other steer.
    // If the blocking call starts after this check (a narrow admission-to-park race), the
    // steer waits out that call like it did before this release existed.
    const releaseSteerBlock = (sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        if (!(yield* coordinator.isActive(sessionID))) return
        if (!(yield* SessionInbox.has(db, sessionID, "steer"))) return
        yield* jobs.backgroundAll({ sessionID })
      })
    const wake = (sessionID: SessionSchema.ID) =>
      coordinator.wake(sessionID).pipe(Effect.andThen(releaseSteerBlock(sessionID)))

    // This boot's claim attribution, or undefined when clustering is not
    // composed: no identity means neither stamping nor wake routing applies.
    const self = Option.isSome(identity)
      ? Effect.gen(function* () {
          const [url] = yield* identity.value.urls
          return { id: identity.value.id, ...(url === undefined ? {} : { url }) }
        })
      : Effect.succeed(undefined)

    // Wake routing for co-mounted servers. Work recorded against a Session
    // whose live claim names another boot is forwarded to that owner so its
    // inbox drains there; a dead or unforwardable owner is fenced away and the
    // wake runs here instead. A wake is never dropped for placement reasons:
    // every hop reads the current durable attribution, so forwarding follows
    // the fence rather than a cached guess and terminates at the owner.
    const wakeRouted = Effect.fn("SessionExecution.wake")(function* (sessionID: SessionSchema.ID) {
      const at = yield* self
      if (at !== undefined) {
        const claim = yield* store.attribution(sessionID)
        if (claim?.owner !== undefined && claim.owner !== at.id) {
          if (Option.isSome(wakes) && claim.url !== undefined) {
            if (
              (yield* wakes.value.probe(claim.url, claim.owner)) &&
              (yield* wakes.value.forward(claim.url, sessionID))
            )
              return
          }
          yield* store.seize(sessionID, at, claim.owner)
        }
      }
      yield* wake(sessionID)
    })
    return Service.of({
      active: coordinator.active,
      isActive: coordinator.isActive,
      interrupt: (sessionID, options) =>
        Effect.gen(function* () {
          const interrupted = yield* coordinator.interrupt(sessionID, "user")
          if (!options?.resume) return interrupted
          // Resume steering input and between-turn control work from the interrupted
          // intent. Queued next-turn prompts stay parked: a steer-scoped drain never
          // promotes them, and a control item behind a queued prompt waits its turn.
          // Interruption acknowledges before cleanup settles, so this wake usually lands
          // on the stopping execution's doorbell and starts the successor at settle.
          // Reading the inbox concurrently with the dying drain is safe: delivery consumes
          // rows inside uninterruptible publications, so a steer row is either still
          // promotable here or was fully delivered and needs no resumption.
          const next = yield* SessionInbox.nextPromotable(db, sessionID, "input")
          if (next === undefined) return interrupted
          if (next.delivery === "steer" || next.type === "compaction" || next.type === "move")
            yield* coordinator.wake(sessionID, "steer")
          return interrupted
        }),
      resume: coordinator.run,
      wake: wakeRouted,
      awaitIdle: coordinator.awaitIdle,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionStore.node, Instance.node, Bus.node, Database.node, Job.node, ServerIdentity.node, SessionWakeForward.node],
})

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    active: Effect.succeed(new Set()),
    isActive: () => Effect.succeed(false),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
  }),
)
