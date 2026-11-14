import { describe, expect } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer, Queue, Stream } from "effect"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { ScrumPlugin } from "@opencode/core/plugin/scrum"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { Todo } from "@opencode/core/todo"
import { WorktreeTable } from "@opencode/core/worktree/sql"
import { Global } from "@opencode/util/global"
import { TestClock } from "effect/testing"
import { it } from "../lib/effect"
import { host } from "./host"

const scrumID = Session.ID.make("ses_scrum")
const DAY = 86_400_000
const week = () => Math.floor(Date.now() / (7 * DAY))
// The stubbed config directory the coordinator is anchored to, mirroring the
// Voice Inbox pattern (location = global config dir, never an ambient project).
const CONFIG = "/config"

type Row = { id: string; directory: string; text: string; status: "open" | "done"; assignee?: string }
type Wake = { sessionID: Session.ID; id: string; text: string; delivery?: string }
type Call = { id: Session.ID; title?: string; agent?: string; location?: { directory: string } }

// The plugin's decision logic against stubbed domains and services: real event
// filtering, id derivation, and gating; the durable inbox's first-admission-wins
// coalescing is covered by the inbox tests, so here equal wake ids prove coalescing.
const run = Effect.fnUntraced(function* (input: {
  enabled?: boolean
  scrum?: unknown
  rows?: Row[]
  idleProjects?: string[]
  agents?: Record<string, string>
  location?: string
}) {
  const wakes: Wake[] = []
  const created: Call[] = []
  const moved: { sessionID: Session.ID; directory: string }[] = []
  const events = yield* Queue.unbounded<{ type: string; data: any }>()
  const rows = input.rows ?? []
  const context = host({
    session: {
      create: (input) =>
        Effect.sync(() => {
          created.push({
            id: input?.id as Session.ID,
            title: input?.title,
            agent: input?.agent && String(input?.agent),
            location: input?.location && { directory: String(input.location.directory) },
          })
          return {} as never
        }),
      get: (get) =>
        Effect.succeed({
          id: get.sessionID,
          agent: input.agents?.[String(get.sessionID)],
          location: { directory: input.location ?? CONFIG },
        } as never),
      move: (move) =>
        Effect.sync(() => {
          moved.push({ sessionID: move.sessionID, directory: String(move.directory) })
          return {} as never
        }),
      synthetic: (wake) =>
        Effect.sync(() => {
          wakes.push({ sessionID: wake.sessionID, id: String(wake.id), text: wake.text, delivery: wake.delivery })
          return {} as never
        }),
    },
    event: { subscribe: () => Stream.fromQueue(events) as never },
  })
  const services = Layer.mergeAll(
    Layer.succeed(Global.Service, Global.Service.of({ ...Global.make(), config: CONFIG })),
    Layer.succeed(
      Config.Service,
      Config.Service.of({
        entries: () =>
          Effect.succeed(
            [
              {
                type: "document",
                info: { experimental: { scrum: input.scrum ?? input.enabled === true } },
              },
            ] as never,
          ),
      } as unknown as Config.Interface),
    ),
    Layer.succeed(
      Todo.Service,
      Todo.Service.of({
        list: (list: { assignee?: string; status?: string } = {}) =>
          Effect.succeed(
            rows.filter(
              (row) =>
                (list.assignee === undefined || row.assignee === list.assignee) &&
                (list.status === undefined || list.status === "all" || row.status === list.status),
            ) as never,
          ),
      } as unknown as Todo.Interface),
    ),
    // The idle-project SQL predicate mirrors Project.list; the stub replays canned rows.
    Layer.succeed(
      Database.Service,
      Database.Service.of({
        db: {
          select: () => ({
            from: () => ({
              where: () => ({
                all: () =>
                  Effect.succeed(
                    (input.idleProjects ?? []).map((id) => ({ id, worktree: `/projects/${id}` })),
                  ),
              }),
            }),
          }),
        },
      } as unknown as Database.Interface),
    ),
  )
  yield* ScrumPlugin.Plugin.effect(context).pipe(Effect.provide(services))
  const emit = (type: string, sessionID: string, data: Record<string, unknown> = {}) =>
    Queue.offer(events, { type, data: { sessionID, ...data } }).pipe(Effect.flatMap(() => flush))
  return { wakes, created, moved, emit }
})

// Lets the forked subscription and scan fibers settle between steps.
const flush = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true })

describe("scrum plugin", () => {
  it.effect("adopts the pinned scrum session when enabled", () =>
    Effect.gen(function* () {
      const { created, moved } = yield* run({ enabled: true })
      yield* flush
      expect(created).toEqual([{ id: scrumID, title: "Scrum", agent: "scrum", location: { directory: CONFIG } }])
      expect(moved).toEqual([])
    }),
  )

  it.effect("relocates a session adopted into a project location", () =>
    Effect.gen(function* () {
      const { moved } = yield* run({ enabled: true, location: "E:/mobile-personal-assistant" })
      yield* flush
      expect(moved).toEqual([{ sessionID: scrumID, directory: CONFIG }])
    }),
  )

  it.effect("does nothing while the experimental gate is off", () =>
    Effect.gen(function* () {
      const { wakes, created, emit } = yield* run({
        rows: [{ id: "t1", directory: "/p", text: "ship", status: "open" }],
        idleProjects: ["prj_gone"],
      })
      yield* TestClock.adjust("6 hours")
      yield* emit("session.execution.succeeded", "ses_worker")
      expect(created).toEqual([])
      expect(wakes).toEqual([])
    }),
  )

  it.effect("wakes scrum with a day-scoped id when a session ends with addressed todos", () =>
    Effect.gen(function* () {
      const { wakes, emit } = yield* run({
        enabled: true,
        rows: [{ id: "t1", directory: "/p", text: "ship it", status: "open", assignee: "ses_worker" }],
        agents: { ses_worker: "build" },
      })
      yield* emit("session.execution.succeeded", "ses_worker")
      yield* emit("session.execution.failed", "ses_worker")
      const done = wakes.filter((wake) => wake.id.startsWith("msg_scrum_done_"))
      expect(done).toHaveLength(2)
      // Repeats carry the same id: the durable inbox admits the first and ignores the rest.
      expect(new Set(done.map((wake) => wake.id)).size).toBe(1)
      expect(done[0].id).toBe(`msg_scrum_done_ses_worker_${Math.floor(Date.now() / DAY)}`)
      expect(done[0].sessionID).toBe(scrumID)
      expect(done[0].delivery).toBe("queue")
      expect(done[0].text).toContain("1 open todo")
    }),
  )

  it.effect("matches todos addressed to the agent name", () =>
    Effect.gen(function* () {
      const { wakes, emit } = yield* run({
        enabled: true,
        rows: [{ id: "t1", directory: "/p", text: "review", status: "open", assignee: "scout" }],
        agents: { ses_worker: "scout" },
      })
      yield* emit("session.execution.succeeded", "ses_worker")
      expect(wakes.some((wake) => wake.id.startsWith("msg_scrum_done_ses_worker"))).toBe(true)
    }),
  )

  it.effect("ignores shutdown interrupts and scrum's own executions", () =>
    Effect.gen(function* () {
      const { wakes, emit } = yield* run({
        enabled: true,
        rows: [{ id: "t1", directory: "/p", text: "ship it", status: "open", assignee: "ses_worker" }],
      })
      yield* emit("session.execution.interrupted", "ses_worker", { reason: "shutdown" })
      yield* emit("session.execution.succeeded", "ses_scrum")
      expect(wakes.filter((wake) => wake.id.startsWith("msg_scrum_done_"))).toEqual([])
    }),
  )

  it.effect("stays quiet when nothing is addressed to a finished session", () =>
    Effect.gen(function* () {
      const { wakes, emit } = yield* run({
        enabled: true,
        rows: [
          { id: "t1", directory: "/p", text: "mine", status: "open", assignee: "ses_other" },
          { id: "t2", directory: "/p", text: "closed", status: "done", assignee: "ses_worker" },
        ],
      })
      yield* emit("session.execution.succeeded", "ses_worker")
      expect(wakes.filter((wake) => wake.id.startsWith("msg_scrum_done_"))).toEqual([])
    }),
  )

  it.effect("fires a daily board-review digest on every scan, coalesced by day", () =>
    Effect.gen(function* () {
      const { wakes } = yield* run({ enabled: true })
      // The scan runs once at start; a six-hour clock step runs it again. Same day,
      // so both admissions share the digest id and the inbox keeps only the first.
      yield* TestClock.adjust("6 hours")
      const digest = wakes.filter((wake) => wake.id.startsWith("msg_scrum_digest_"))
      expect(digest).toHaveLength(2)
      expect(new Set(digest.map((wake) => wake.id)).size).toBe(1)
      expect(digest[0].id).toBe(`msg_scrum_digest_${Math.floor(Date.now() / DAY)}`)
      expect(digest[0].sessionID).toBe(scrumID)
      expect(digest[0].delivery).toBe("queue")
      expect(digest[0].text).toContain("daily board review")
    }),
  )

  it.effect("surfaces unclaimed todos on each scan and idle projects as one batched message", () =>
    Effect.gen(function* () {
      const { wakes } = yield* run({
        enabled: true,
        rows: [
          { id: "todo_free", directory: "/p", text: "nobody owns me", status: "open" },
          { id: "todo_done", directory: "/p", text: "finished", status: "done" },
        ],
        idleProjects: ["prj_stale", "prstale2"],
      })
      // The scan runs once at start; a six-hour clock step runs it again.
      yield* TestClock.adjust("6 hours")
      const unclaimed = wakes.filter((wake) => wake.id.startsWith("msg_scrum_unclaimed_"))
      const idle = wakes.filter((wake) => wake.id.startsWith("msg_scrum_idle_"))
      expect(unclaimed.map((wake) => wake.id)).toEqual([
        `msg_scrum_unclaimed_todo_free`,
        `msg_scrum_unclaimed_todo_free`,
      ])
      // One message per scan no matter how many projects are idle, week-scoped so
      // re-runs coalesce.
      expect(idle.map((wake) => wake.id)).toEqual([`msg_scrum_idle_${week()}`, `msg_scrum_idle_${week()}`])
      expect(idle[0].sessionID).toBe(scrumID)
      expect(idle[0].text).toContain("2 project(s) idle")
      expect(idle[0].text).toContain("prj_stale")
      expect(idle[0].text).toContain("prstale2")
    }),
  )

  it.effect("a settings block enables the coordinator and tunes the idle threshold", () =>
    Effect.gen(function* () {
      const { wakes, created } = yield* run({ scrum: { idle_project_days: 10 }, idleProjects: ["prj_stale"] })
      yield* flush
      expect(created).toHaveLength(1)
      const idle = wakes.filter((wake) => wake.id.startsWith("msg_scrum_idle_"))
      expect(idle).toHaveLength(1)
      expect(idle[0].text).toContain("idle for over 10 days")
    }),
  )
})

// The idle scan's exclusions (sessionless directories, worktree paths) live in SQL
// that the stubbed harness above replays blindly, so these run the plugin's real
// query against an in-memory database with real project/session/worktree rows.
const runIdle = Effect.fnUntraced(function* (input: {
  scrum?: unknown
  projects: Array<{
    id: string
    worktree: string
    activeDaysAgo: number
    sessions?: number
    registeredUnder?: { project: string; directory: string }
  }>
}) {
  const wakes: Wake[] = []
  const context = host({
    session: {
      create: () => Effect.succeed({} as never),
      get: () => Effect.succeed({ id: scrumID, location: { directory: CONFIG } } as never),
      synthetic: (synthetic) =>
        Effect.sync(() => {
          wakes.push({ sessionID: synthetic.sessionID, id: String(synthetic.id), text: synthetic.text })
          return {} as never
        }),
    },
  })
  const globalLayer = Layer.succeed(
    Global.Service,
    Global.Service.of({ ...Global.make(), config: CONFIG, data: "/data" }),
  )
  const services = Layer.mergeAll(
    globalLayer,
    Layer.succeed(
      Config.Service,
      Config.Service.of({
        entries: () =>
          Effect.succeed([{ type: "document", info: { experimental: { scrum: input.scrum ?? true } } }] as never),
      } as unknown as Config.Interface),
    ),
    Layer.succeed(
      Todo.Service,
      Todo.Service.of({ list: () => Effect.succeed([] as never) } as unknown as Todo.Interface),
    ),
    Database.layerFromClient.pipe(
      Layer.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      Layer.provide(globalLayer),
    ),
  )
  yield* Effect.gen(function* () {
    const database = yield* Database.Service
    yield* Effect.forEach(input.projects, (project) =>
      Effect.gen(function* () {
        yield* database.db
          .insert(ProjectTable)
          .values({
            id: project.id as never,
            worktree: AbsolutePath.make(project.worktree),
            sandboxes: [],
            time_active: Date.now() - project.activeDaysAgo * DAY,
          })
          .run()
        const sessions = Array.from({ length: project.sessions ?? 0 }, (_, index) => ({
          id: `ses_${project.id}_${index}` as never,
          project_id: project.id as never,
          slug: `slug-${project.id}-${index}`,
          directory: project.worktree,
          version: "test",
        }))
        if (sessions.length > 0) yield* database.db.insert(SessionTable).values(sessions).run()
        if (project.registeredUnder)
          yield* database.db
            .insert(WorktreeTable)
            .values({
              project_id: project.registeredUnder.project as never,
              directory: AbsolutePath.make(project.registeredUnder.directory),
            })
            .onConflictDoNothing()
            .run()
      }),
    )
    // The plugin boots on this same context, so its scan runs the real query.
    yield* ScrumPlugin.Plugin.effect(context)
    yield* flush
  }).pipe(Effect.scoped, Effect.provide(services))
  const idle = wakes.filter((wake) => wake.id.startsWith("msg_scrum_idle_"))
  return { idle, text: idle.map((wake) => wake.text).join("\n") }
})

describe("scrum idle scan against a real database", () => {
  const stale = 5
  const projects = [
    { id: "prj_real", worktree: "/repo/real", activeDaysAgo: stale, sessions: 1 },
    { id: "prj_sessionless", worktree: "/repo/sessionless", activeDaysAgo: stale },
    { id: "prj_lane", worktree: "/repo/real-lane", activeDaysAgo: stale, sessions: 1, registeredUnder: { project: "prj_real", directory: "/repo/real-lane" } },
    { id: "prj_lane_sub", worktree: "/repo/real-lane/subdir", activeDaysAgo: stale, sessions: 1, registeredUnder: { project: "prj_real", directory: "/repo/real-lane" } },
    { id: "prj_managed", worktree: "/data/worktree/0123/lane", activeDaysAgo: stale, sessions: 1 },
    { id: "prj_recent", worktree: "/repo/recent", activeDaysAgo: 2, sessions: 1 },
    { id: "global", worktree: "/", activeDaysAgo: stale, sessions: 3 },
  ]

  it.effect("wakes once for real idle projects, skipping sessionless rows, registered worktrees, managed worktrees, and the global catch-all", () =>
    Effect.gen(function* () {
      const { idle, text } = yield* runIdle({ projects })
      expect(idle).toHaveLength(1)
      expect(idle[0].id).toBe(`msg_scrum_idle_${week()}`)
      expect(idle[0].text).toContain("1 project(s) idle")
      expect(text).toContain("prj_real")
      expect(text).not.toContain("prj_sessionless")
      expect(text).not.toContain("prj_lane")
      expect(text).not.toContain("prj_managed")
      expect(text).not.toContain("prj_recent")
      expect(text).not.toContain("global")
    }),
  )

  it.effect("honors a custom idle threshold from the settings block", () =>
    Effect.gen(function* () {
      const raised = yield* runIdle({ scrum: { idle_project_days: 10 }, projects })
      expect(raised.idle).toHaveLength(0)
      const lowered = yield* runIdle({ scrum: { idle_project_days: 1 }, projects })
      expect(lowered.idle).toHaveLength(1)
      expect(lowered.text).toContain("prj_recent")
      expect(lowered.text).not.toContain("prj_sessionless")
      expect(lowered.text).not.toContain("prj_lane")
      expect(lowered.text).not.toContain("prj_managed")
      expect(lowered.text).not.toContain("global")
    }),
  )
})
