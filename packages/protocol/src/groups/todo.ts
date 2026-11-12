import { HttpApiEndpoint, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { Todo } from "@opencode/schema/todo"
import { InvalidRequestError, TodoNotFoundError } from "../errors.js"

const annotations = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({
    identifier: `experimental.todo.${identifier}`,
    summary,
    description: `${description} Experimental: may change without compatibility guarantees.`,
    transform: (operation) => ({ ...operation, tags: ["experimental"] }),
  })

const errors = [InvalidRequestError] as const
const itemErrors = [TodoNotFoundError, ...errors] as const
const params = { id: Schema.String }

/** Lives in the `server.experimental` group (see `groups/experimental.ts`). */
export const TodoEndpoints = [
  HttpApiEndpoint.get("todo.list", "/api/experimental/todo", {
    query: Schema.Struct({
      directory: Schema.String.pipe(Schema.optional),
      status: Todo.Status.pipe(Schema.optional),
    }),
    success: Schema.Struct({ data: Schema.Array(Todo.Info) }),
    error: errors,
  }).annotateMerge(
    annotations(
      "list",
      "List project todos",
      "Durable per-project todos (plain open/done items with descriptions and references to transcripts or documents). Lists one project when `directory` is given, otherwise every project; each row carries its own directory so clients can group.",
    ),
  ),
  HttpApiEndpoint.post("todo.add", "/api/experimental/todo", {
    payload: Todo.AddInput,
    success: Schema.Struct({ data: Todo.Info }),
    error: errors,
  }).annotateMerge(
    annotations(
      "add",
      "Add a project todo",
      "Adds an open todo to a project. A caller-chosen id makes retried extractions idempotent: an existing id returns the stored todo unchanged instead of duplicating.",
    ),
  ),
  HttpApiEndpoint.patch("todo.update", "/api/experimental/todo/:id", {
    params,
    payload: Todo.UpdateInput,
    success: Schema.Struct({ data: Todo.Info }),
    error: itemErrors,
  }).annotateMerge(
    annotations(
      "update",
      "Update, complete, or reopen a project todo",
      "Edits text, description, or references and flips status between open and done; done_at is stamped automatically on the transition.",
    ),
  ),
  HttpApiEndpoint.delete("todo.remove", "/api/experimental/todo/:id", {
    params,
    success: Schema.Struct({ data: Schema.Struct({ removed: Schema.Boolean }) }),
    error: itemErrors,
  }).annotateMerge(annotations("remove", "Delete a project todo", "Removes the todo permanently.")),
] as const
