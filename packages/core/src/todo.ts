export * as Todo from "./todo.js"

import { desc, eq, and, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { Todo as TodoSchema } from "@opencode/schema/todo"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "./database/database.js"
import { ProjectTodoTable } from "./todo/sql.js"

export type Info = TodoSchema.Info
export type Status = TodoSchema.Status

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Todo.NotFoundError", {
  id: Schema.String,
  message: Schema.String,
}) {}

export interface Interface {
  /** Todos for one project when `directory` is given, otherwise every project's — each row carries its directory. `assignee` keeps only rows addressed to that agent or session. */
  readonly list: (input?: {
    readonly directory?: string
    readonly status?: Status | "all"
    readonly assignee?: string
  }) => Effect.Effect<ReadonlyArray<Info>>
  /** `id` makes additions idempotent: an existing id returns the stored row untouched. */
  readonly add: (input: {
    readonly directory: string
    readonly text: string
    readonly description?: string
    readonly refs?: readonly TodoSchema.Ref[]
    readonly source?: TodoSchema.Source
    readonly assignee?: string
    readonly id?: string
  }) => Effect.Effect<Info>
  readonly update: (input: {
    readonly id: string
    readonly text?: string
    readonly description?: string
    readonly refs?: readonly TodoSchema.Ref[]
    readonly status?: Status
    readonly assignee?: string
  }) => Effect.Effect<Info, NotFoundError>
  readonly remove: (input: { readonly id: string }) => Effect.Effect<void, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Todo") {}

/** Stable id for a (project, note, index) triple so retried voice extractions collide into one row. */
export const derivedID = (key: string) => `todo_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`

const row = (todo: typeof ProjectTodoTable.$inferSelect): Info => ({
  id: todo.id,
  directory: todo.directory,
  text: todo.text,
  ...(todo.description === null ? {} : { description: todo.description }),
  ...(todo.refs === null ? {} : { refs: todo.refs }),
  status: todo.status,
  ...(todo.done_at === null ? {} : { done_at: todo.done_at }),
  source: todo.source,
  ...(todo.assignee === null || todo.assignee === "" ? {} : { assignee: todo.assignee }),
  time_created: todo.time_created,
  time_updated: todo.time_updated,
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const byID = Effect.fn("Todo.byID")(function* (id: string) {
      const found = yield* db.select().from(ProjectTodoTable).where(eq(ProjectTodoTable.id, id)).get().pipe(Effect.orDie)
      return found
    })

    const list = Effect.fn("Todo.list")(function* (input?: {
      directory?: string
      status?: Status | "all"
      assignee?: string
    }) {
      const where = [
        ...(input?.directory === undefined ? [] : [eq(ProjectTodoTable.directory, input.directory)]),
        ...(input?.status === undefined || input?.status === "all" ? [] : [eq(ProjectTodoTable.status, input.status)]),
        ...(input?.assignee === undefined ? [] : [eq(ProjectTodoTable.assignee, input.assignee)]),
      ]
      const rows = yield* db
        .select()
        .from(ProjectTodoTable)
        .where(where.length === 0 ? undefined : and(...where))
        // Open first, then most recent first; the right panel shows the actionable head without sorting.
        .orderBy(sql`${ProjectTodoTable.status} = 'done'`, desc(ProjectTodoTable.time_created))
        .all()
        .pipe(Effect.orDie)
      return rows.map(row)
    })

    const add = Effect.fn("Todo.add")(function* (input: {
      directory: string
      text: string
      description?: string
      refs?: readonly TodoSchema.Ref[]
      source?: TodoSchema.Source
      assignee?: string
      id?: string
    }) {
      const id = input.id ?? `todo_${randomUUID()}`
      const existing = yield* byID(id)
      if (existing !== undefined) return row(existing)
      // Row timestamps come from the table's own defaults, so the service stays clock-free.
      const inserted = yield* db
        .insert(ProjectTodoTable)
        .values({
          id,
          directory: input.directory,
          text: input.text,
          description: input.description ?? null,
          refs: input.refs ?? null,
          status: "open",
          done_at: null,
          source: input.source ?? "user",
          assignee: input.assignee?.trim() === "" ? null : (input.assignee ?? null),
        })
        .returning()
        .get()
        .pipe(Effect.orDie)
      return row(inserted)
    })

    const update = Effect.fn("Todo.update")(function* (input: {
      id: string
      text?: string
      description?: string
      refs?: readonly TodoSchema.Ref[]
      status?: Status
      assignee?: string
    }) {
      const existing = yield* byID(input.id)
      if (existing === undefined)
        return yield* new NotFoundError({ id: input.id, message: `No todo with id ${input.id}` })
      const done = input.status === "done" && existing.status !== "done"
      const reopened = input.status === "open" && existing.status === "done"
      const values = {
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.refs === undefined ? {} : { refs: input.refs }),
        ...(input.status === undefined ? {} : { status: input.status }),
        // An empty assignee clears the assignment, opening the todo to the whole project.
        ...(input.assignee === undefined ? {} : { assignee: input.assignee.trim() === "" ? null : input.assignee }),
        // done_at records the completion instant; time_updated rides the column's own onUpdate.
        ...(done ? { done_at: Date.now() } : reopened ? { done_at: null } : {}),
      }
      const updated = yield* db
        .update(ProjectTodoTable)
        .set(values)
        .where(eq(ProjectTodoTable.id, input.id))
        .returning()
        .get()
        .pipe(Effect.orDie)
      return row(updated)
    })

    const remove = Effect.fn("Todo.remove")(function* (input: { id: string }) {
      const deleted = yield* db
        .delete(ProjectTodoTable)
        .where(eq(ProjectTodoTable.id, input.id))
        .returning({ id: ProjectTodoTable.id })
        .run()
        .pipe(Effect.orDie)
      if (deleted.length === 0)
        return yield* new NotFoundError({ id: input.id, message: `No todo with id ${input.id}` })
    })

    return Service.of({ list, add, update, remove })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

