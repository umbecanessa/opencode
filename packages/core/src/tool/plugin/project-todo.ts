export * as ProjectTodoTool from "./project-todo.js"

import { Effect, Schema } from "effect"
import { Todo } from "@opencode/schema/todo"
import { Global } from "@opencode/util/global"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "../../session.js"
import { Todo as TodoService } from "../../todo.js"

// Distinct from `todowrite`, the session-scoped planning checklist: this store is the durable
// per-project todo list shared with voice-note triage and the UI, so work outlives any session.
export const name = "todo"

const Ref = Schema.Struct({
  label: Schema.String.annotate({ description: "Short label, e.g. the transcript or document title" }),
  uri: Schema.String.annotate({ description: "File path, voice://<recordingId>, or URL" }),
})

const Input = Schema.Struct({
  action: Schema.Literals(["list", "add", "update", "done", "delete"]).annotate({
    description: "list reads the current todos; add creates one; update edits text/description/refs/assignee; done completes; delete removes",
  }),
  text: Schema.String.pipe(Schema.optional).annotate({ description: "Imperative one-line task, for add and update" }),
  id: Schema.String.pipe(Schema.optional).annotate({ description: "Todo id from a previous list/add result" }),
  description: Schema.String.pipe(Schema.optional).annotate({ description: "Why this todo exists; context and provenance" }),
  refs: Schema.Array(Ref).pipe(Schema.optional).annotate({ description: "Transcripts or documents this todo refers to" }),
  directory: Schema.String.pipe(Schema.optional).annotate({
    description: "Project directory to operate on; defaults to this session's project",
  }),
  assignee: Schema.String.pipe(Schema.optional).annotate({
    description:
      "On add/update: who the todo is for — an agent name (yours or another agent's), a session id, or \"all\" for any agent; empty string clears the assignment. On list: restrict to rows addressed to this name",
  }),
})

const Output = Schema.Struct({
  todos: Schema.Array(Todo.Info),
  message: Schema.String,
})

const missing = (id: string) => `No todo with id ${id} in this project`

export const Plugin = {
  id: "opencode.tool.project-todo",
  effect: Effect.fn("ProjectTodoTool.Plugin")(function* (ctx: Context) {
    const global = yield* Global.Service
    const session = yield* Session.Service
    const todo = yield* TodoService.Service

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name,
          options: { codemode: false },
          description:
            "Read and manage the durable per-project todo list (plain open/done tasks shared with the user's voice-note triage and UI; distinct from the session-scoped todowrite plan). Keeping it current is part of the job: add work you discover, mark items done when finished. When the user asks you to check your todos, use list: it returns this project's unassigned items plus those addressed to you (assignee naming your agent or \"all\"). Assign work to another agent or session with add/update assignee.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const info =
                context.sessionID === undefined
                  ? undefined
                  : yield* session.get(context.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
              const scope = input.directory ?? info?.location.directory ?? global.config
              // The running agent's own name: what "assigned to me" matches against.
              const me = info?.agent
              let message = ""
              let listed: ReadonlyArray<Todo.Info> | undefined
              if (input.action === "list") {
                if (input.assignee !== undefined) {
                  listed = yield* todo.list({ assignee: input.assignee })
                  message = `Todos addressed to ${input.assignee}.`
                } else if (me === undefined) {
                  listed = yield* todo.list({ directory: scope })
                  message = "Current todos."
                } else {
                  // Mine by default: this project's items (open to whoever works here) plus
                  // anything addressed to this agent or to "all", even from other projects.
                  const here = yield* todo.list({ directory: scope })
                  const addressed = yield* Effect.all([todo.list({ assignee: me }), todo.list({ assignee: "all" })])
                  const byID = new Map(
                    [...here, ...addressed[0], ...addressed[1]]
                      .filter((todo) => todo.assignee === undefined || todo.assignee === me || todo.assignee === "all")
                      .map((todo) => [todo.id, todo]),
                  )
                  listed = [...byID.values()].sort(
                    (a, b) => Number(a.status === "done") - Number(b.status === "done") || b.time_created - a.time_created,
                  )
                  message = `Todos for agent "${me}": this project's items plus those addressed to you or \"all\".`
                }
              } else if (input.action === "add") {
                if (input.text === undefined || input.text.trim() === "") message = "add needs text."
                else {
                  yield* todo.add({
                    directory: scope,
                    text: input.text,
                    ...(input.description === undefined ? {} : { description: input.description }),
                    ...(input.refs === undefined ? {} : { refs: input.refs }),
                    ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
                    source: "agent",
                  })
                  message = `Added: ${input.text}`
                }
              } else if (input.id === undefined) {
                message = `${input.action} needs id.`
              } else if (input.action === "update") {
                const outcome = yield* todo
                  .update({
                    id: input.id,
                    ...(input.text === undefined ? {} : { text: input.text }),
                    ...(input.description === undefined ? {} : { description: input.description }),
                    ...(input.refs === undefined ? {} : { refs: input.refs }),
                    ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
                  })
                  .pipe(Effect.catchTag("Todo.NotFoundError", () => Effect.succeed(undefined)))
                message = outcome === undefined ? missing(input.id) : `Updated ${input.id}.`
              } else if (input.action === "done") {
                const outcome = yield* todo
                  .update({ id: input.id, status: "done" })
                  .pipe(Effect.catchTag("Todo.NotFoundError", () => Effect.succeed(undefined)))
                message = outcome === undefined ? missing(input.id) : `Done: ${input.id}.`
              } else {
                const removed = yield* todo
                  .remove({ id: input.id })
                  .pipe(Effect.as(true), Effect.catchTag("Todo.NotFoundError", () => Effect.succeed(false)))
                message = removed ? `Deleted ${input.id}.` : missing(input.id)
              }
              // Every action ends with a list in scope, so the model always sees the state it caused.
              const todos = listed ?? (yield* todo.list({ directory: scope, status: "open" }))
              return {
                output: { todos: [...todos], message },
                content: `${message} ${todos.length} todo(s) listed.`,
              }
            }),
        })
      })
      .pipe(Effect.orDie)
  }),
}
