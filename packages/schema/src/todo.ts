export * as Todo from "./todo.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema.js"

export const Status = Schema.Literals(["open", "done"]).annotate({ identifier: "Todo.Status" })
export type Status = typeof Status.Type

export const Source = Schema.Literals(["voice", "agent", "user"]).annotate({ identifier: "Todo.Source" })
export type Source = typeof Source.Type

export interface Ref extends Schema.Schema.Type<typeof Ref> {}
export const Ref = Schema.Struct({
  label: Schema.String.annotate({ description: "Short human label, e.g. the transcript or document title" }),
  uri: Schema.String.annotate({ description: "Pointer the user or an agent can follow: file path, voice://<recordingId>, or URL" }),
}).annotate({ identifier: "Todo.Ref" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: Schema.String.annotate({ description: "Stable id; derived ids make retried additions idempotent" }),
  directory: Schema.String.annotate({ description: "Project directory the todo belongs to" }),
  text: Schema.String.annotate({ description: "The action to take, imperative, one line" }),
  description: optional(Schema.String.annotate({ description: "Context: why this exists, from which transcript or document" })),
  refs: optional(Schema.Array(Ref).annotate({ description: "Transcripts, documents, or links this todo refers to" })),
  status: Status,
  done_at: optional(NonNegativeInt.annotate({ description: "Epoch millis when marked done" })),
  source: Source,
  time_created: NonNegativeInt,
  time_updated: NonNegativeInt,
}).annotate({ identifier: "Todo.Info" })

export interface AddInput extends Schema.Schema.Type<typeof AddInput> {}
export const AddInput = Schema.Struct({
  text: Schema.String,
  directory: optional(Schema.String.annotate({ description: "Project directory; defaults to the server home project" })),
  description: optional(Schema.String),
  refs: optional(Schema.Array(Ref)),
  source: optional(Source),
  id: optional(Schema.String.annotate({ description: "Caller-chosen id; an existing id is ignored and the stored todo returned" })),
}).annotate({ identifier: "Todo.AddInput" })

export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}
export const UpdateInput = Schema.Struct({
  text: optional(Schema.String),
  description: optional(Schema.String),
  refs: optional(Schema.Array(Ref)),
  status: optional(Status),
}).annotate({ identifier: "Todo.UpdateInput" })
