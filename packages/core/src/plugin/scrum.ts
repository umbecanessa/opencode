export * as ScrumPlugin from "./scrum.js"

import { define } from "@opencode/plugin/effect/plugin"
import { and, isNull, lt } from "drizzle-orm"
import { Effect, Schedule, Stream } from "effect"
import { Agent } from "../agent.js"
import { Config } from "../config.js"
import { Database } from "../database/database.js"
import { ProjectTable } from "../project/sql.js"
import { Session } from "../session.js"
import { SessionMessage } from "../session/message.js"
import { Todo } from "../todo.js"

// One coordinator session for the whole server; Session.create adopts a reused ID,
// so instantiation from several locations converges on the same row.
const ScrumSessionID = Session.ID.make("ses_scrum")
const DAY_MS = 86_400_000
const IDLE_PROJECT_DAYS = 3

export const Plugin = define({
  id: "opencode.scrum",
  effect: Effect.fnUntraced(function* (ctx) {
    const config = yield* Config.Service
    if (Config.latest(yield* config.entries(), "experimental")?.scrum !== true) return

    const todo = yield* Todo.Service
    const database = yield* Database.Service
    yield* ctx.session.create({ id: ScrumSessionID, title: "Scrum", agent: Agent.ID.make("scrum") }).pipe(Effect.orDie)

    // Wakes ride the durable synthetic inbox with stable derived ids: first admission
    // wins, so repeated events, repeated scans, and duplicate plugin instances coalesce.
    const wake = (id: string, text: string) =>
      ctx.session
        .synthetic({ sessionID: ScrumSessionID, id: SessionMessage.ID.make(id), text, delivery: "queue" })
        .pipe(Effect.ignore)

    // Termination leg: a session going idle or ending wakes scrum only while open
    // todos are still addressed to it (by session id or agent name). Day-scoped ids
    // cap this at one wake per session per day, matching the nudge etiquette.
    yield* ctx.event
      .subscribe({
        types: ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"],
      })
      .pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const sessionID = event.data.sessionID
            if (sessionID === ScrumSessionID) return
            if (event.type === "session.execution.interrupted" && event.data.reason === "shutdown") return
            const info = yield* ctx.session.get({ sessionID })
            const addressed = yield* Effect.all([
              todo.list({ assignee: sessionID, status: "open" }),
              ...(info?.agent ? [todo.list({ assignee: String(info.agent), status: "open" })] : []),
            ])
            const open = addressed.flat()
            if (open.length === 0) return
            const outcome = event.type.slice("session.execution.".length)
            yield* wake(
              `msg_scrum_done_${sessionID}_${Math.floor(Date.now() / DAY_MS)}`,
              `scrum wake: session ${sessionID} went ${outcome} with ${open.length} open todo(s) addressed to it.`,
            )
          }),
        ),
        Effect.ignore,
        Effect.forkScoped({ startImmediately: true }),
      )

    // Periodic scans, cheap enough to run every six hours:
    // - unclaimed open todos wake scrum once per item, forever (id is the todo id);
    // - idle projects wake scrum once per project per week.
    yield* Effect.gen(function* () {
      const unclaimed = (yield* todo.list({ status: "all" })).filter((item) => item.status === "open" && !item.assignee)
      yield* Effect.forEach(unclaimed, (item) =>
        wake(`msg_scrum_unclaimed_${item.id}`, `scrum wake: unclaimed todo in ${item.directory}: "${item.text}"`),
      )
      const week = Math.floor(Date.now() / (7 * DAY_MS))
      // Same predicate as Project.list's default: skip archived projects.
      const idle = yield* database.db
        .select({ id: ProjectTable.id })
        .from(ProjectTable)
        .where(
          and(
            isNull(ProjectTable.time_archived),
            lt(ProjectTable.time_active, Date.now() - IDLE_PROJECT_DAYS * DAY_MS),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(idle, (item) =>
        wake(
          `msg_scrum_idle_${item.id}_${week}`,
          `scrum wake: project ${item.id} has been idle for over ${IDLE_PROJECT_DAYS} days.`,
        ),
      )
    }).pipe(Effect.ignore, Effect.repeat(Schedule.spaced("6 hours")), Effect.forkScoped({ startImmediately: true }))
  }),
})
