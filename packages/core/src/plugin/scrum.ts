export * as ScrumPlugin from "./scrum.js"

import path from "path"
import { define } from "@opencode/plugin/effect/plugin"
import { and, eq, exists, isNull, like, lt, ne, not, or, sql } from "drizzle-orm"
import { Effect, Schedule, Stream } from "effect"
import { Global } from "@opencode/util/global"
import { sameDirectory } from "@opencode/util/path"
import { Agent } from "../agent.js"
import { Config } from "../config.js"
import { Database } from "../database/database.js"
import { storedAbsolutePath } from "../database/path.js"
import { AbsolutePath } from "../schema.js"
import { ProjectSchema } from "../project/schema.js"
import { ProjectTable } from "../project/sql.js"
import { Session } from "../session.js"
import { SessionMessage } from "../session/message.js"
import { SessionTable } from "../session/sql.js"
import { Todo } from "../todo.js"
import { WorktreeTable } from "../worktree/sql.js"

// One coordinator session for the whole server; Session.create adopts a reused ID,
// so instantiation from several locations converges on the same row. Adoption is
// anchored to the config directory (like the Voice Inbox), NOT to whichever project
// location booted the plugin first — an ambient location would nest the coordinator
// under some unrelated project in the sidebar.
const ScrumSessionID = Session.ID.make("ses_scrum")
const DAY_MS = 86_400_000
const IDLE_PROJECT_DAYS = 3

export const Plugin = define({
  id: "opencode.scrum",
  effect: Effect.fnUntraced(function* (ctx) {
    const config = yield* Config.Service
    const scrum = Config.latest(yield* config.entries(), "experimental")?.scrum
    // A settings block counts as enabled, like the memory/voice keys; the struct
    // form exists to tune the scan, so gating it off behind `true` would defeat it.
    if (scrum !== true && typeof scrum !== "object") return
    const idleDays = (typeof scrum === "object" ? scrum.idle_project_days : undefined) ?? IDLE_PROJECT_DAYS

    const todo = yield* Todo.Service
    const database = yield* Database.Service
    const global = yield* Global.Service
    const home = AbsolutePath.make(global.config)
    yield* ctx.session
      .create({ id: ScrumSessionID, title: "Scrum", agent: Agent.ID.make("scrum"), location: { directory: home } })
      .pipe(Effect.orDie)
    // Cut over hosts that adopted the session in a project location before this fix.
    const adopted = yield* ctx.session.get({ sessionID: ScrumSessionID }).pipe(Effect.orElseSucceed(() => undefined))
    if (adopted?.location && !sameDirectory(adopted.location.directory, home))
      yield* ctx.session.move({ sessionID: ScrumSessionID, directory: home }).pipe(Effect.ignore)

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
    // - a daily board-review digest, so quiet days still get a triage pass;
    // - unclaimed open todos wake scrum once per item, forever (id is the todo id);
    // - idle projects ride one week-scoped digest, so a sweep costs one wake, not N.
    yield* Effect.gen(function* () {
      yield* wake(
        `msg_scrum_digest_${Math.floor(Date.now() / DAY_MS)}`,
        "scrum wake: daily board review. Reconcile open todos against reality (releases, commits, finished sessions) and mark the completed ones done with ledger notes; sweep stale and duplicate items; then if exactly one item is ripe and unowned, propose it to the user: what you see, why it matters now, shall we do it?",
      )
      const unclaimed = (yield* todo.list({ status: "all" })).filter((item) => item.status === "open" && !item.assignee)
      yield* Effect.forEach(unclaimed, (item) =>
        wake(`msg_scrum_unclaimed_${item.id}`, `scrum wake: unclaimed todo in ${item.directory}: "${item.text}"`),
      )
      const week = Math.floor(Date.now() / (7 * DAY_MS))
      // Idle sweep. Archived projects are skipped, matching Project.list's default.
      // A project that never held a session is a directory that was merely glanced
      // at, not a project, and directories registered as worktrees of another
      // project (agent lanes, release cuts) belong to their parent's activity, so
      // neither wakes scrum. The "global" catch-all row is where sessionless orphans
      // live, never a real idle repository; Project.sweep excludes it the same way.
      const managed = storedAbsolutePath(path.join(global.data, "worktree")) + "/%"
      const idle = yield* database.db
        .select({ id: ProjectTable.id, worktree: ProjectTable.worktree })
        .from(ProjectTable)
        .where(
          and(
            isNull(ProjectTable.time_archived),
            ne(ProjectTable.id, ProjectSchema.ID.global),
            lt(ProjectTable.time_active, Date.now() - idleDays * DAY_MS),
            exists(database.db.select({ one: sql`1` }).from(SessionTable).where(eq(SessionTable.project_id, ProjectTable.id))),
            not(
              exists(
                database.db
                  .select({ one: sql`1` })
                  .from(WorktreeTable)
                  .where(
                    and(
                      ne(WorktreeTable.project_id, ProjectTable.id),
                      or(
                        eq(WorktreeTable.directory, ProjectTable.worktree),
                        like(ProjectTable.worktree, sql`${WorktreeTable.directory} || '/%'`),
                      ),
                    ),
                  ),
              ),
            ),
            not(like(ProjectTable.worktree, managed)),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      if (idle.length > 0)
        yield* wake(
          `msg_scrum_idle_${week}`,
          `scrum wake: ${idle.length} project(s) idle for over ${idleDays} days: ` +
            idle
              .slice(0, 20)
              .map((item) => `${item.id} (${item.worktree})`)
              .join(", ") +
            (idle.length > 20 ? ` and ${idle.length - 20} more` : ""),
        )
    }).pipe(Effect.ignore, Effect.repeat(Schedule.spaced("6 hours")), Effect.forkScoped({ startImmediately: true }))
  }),
})
