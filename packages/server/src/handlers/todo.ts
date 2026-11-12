import { Todo } from "@opencode/core/todo"
import { Todo as TodoSchema } from "@opencode/schema/todo"
import { Global } from "@opencode/util/global"
import { InvalidRequestError, TodoNotFoundError } from "@opencode/protocol/errors"
import { Effect } from "effect"

/** `todo.*` in the `server.experimental` group. Durable per-project todos shared by voice notes, agents, and the UI. */
export const makeTodo = Effect.gen(function* () {
  const global = yield* Global.Service
  const todo = yield* Todo.Service

  // Core's service-local tag reads as a missing row on the wire.
  const missing = (id: string) => new TodoNotFoundError({ id, message: `Todo not found: ${id}` })

  return {
    list: (query: { readonly directory?: string; readonly status?: Todo.Status; readonly assignee?: string }) =>
      todo
        .list({
          ...(query.directory === undefined ? {} : { directory: query.directory }),
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.assignee === undefined ? {} : { assignee: query.assignee }),
        })
        .pipe(Effect.map((data) => ({ data }))),
    add: (payload: TodoSchema.AddInput) =>
      Effect.gen(function* () {
        if (payload.text.trim() === "")
          return yield* new InvalidRequestError({ message: "Todo text must not be empty" })
        return {
          data: yield* todo.add({
            directory: payload.directory ?? global.config,
            text: payload.text,
            ...(payload.description === undefined ? {} : { description: payload.description }),
            ...(payload.refs === undefined ? {} : { refs: payload.refs }),
            ...(payload.source === undefined ? {} : { source: payload.source }),
            ...(payload.assignee === undefined ? {} : { assignee: payload.assignee }),
            ...(payload.id === undefined ? {} : { id: payload.id }),
          }),
        }
      }),
    update: (id: string, payload: TodoSchema.UpdateInput) =>
      todo.update({ id, ...payload }).pipe(
        Effect.mapError(() => missing(id)),
        Effect.map((data) => ({ data })),
      ),
    remove: (id: string) =>
      todo.remove({ id }).pipe(
        Effect.mapError(() => missing(id)),
        Effect.as({ data: { removed: true } }),
      ),
  }
})
