import { describe, expect } from "bun:test"
import { Effect, Layer, Queue, Stream } from "effect"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { ScrumPlugin } from "@opencode/core/plugin/scrum"
import { Session } from "@opencode/core/session"
import { Todo } from "@opencode/core/todo"
import { Global } from "@opencode/util/global"
import { TestClock } from "effect/testing"
import { it } from "../lib/effect"
import { host } from "./host"

const scrumID = Session.ID.make("ses_scrum")
const DAY = 86_400_000
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
        entries: () => Effect.succeed([{ type: "document", info: { experimental: { scrum: input.enabled === true } } }] as never),
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
              where: () => ({ all: () => Effect.succeed((input.idleProjects ?? []).map((id) => ({ id }))) }),
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

  it.effect("surfaces unclaimed todos and idle projects on each scan, coalesced by id", () =>
    Effect.gen(function* () {
      const { wakes } = yield* run({
        enabled: true,
        rows: [
          { id: "todo_free", directory: "/p", text: "nobody owns me", status: "open" },
          { id: "todo_done", directory: "/p", text: "finished", status: "done" },
        ],
        idleProjects: ["prj_stale"],
      })
      // The scan runs once at start; a six-hour clock step runs it again.
      yield* TestClock.adjust("6 hours")
      const unclaimed = wakes.filter((wake) => wake.id.startsWith("msg_scrum_unclaimed_"))
      const idle = wakes.filter((wake) => wake.id.startsWith("msg_scrum_idle_"))
      expect(unclaimed.map((wake) => wake.id)).toEqual([
        `msg_scrum_unclaimed_todo_free`,
        `msg_scrum_unclaimed_todo_free`,
      ])
      expect(new Set(idle.map((wake) => wake.id)).size).toBe(1)
      expect(idle[0].id.startsWith(`msg_scrum_idle_prj_stale_`)).toBe(true)
      expect(idle[0].id.endsWith(`_${Math.floor(Date.now() / (7 * DAY))}`)).toBe(true)
    }),
  )
})
