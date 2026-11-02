export * as Memory from "./memory.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"

/**
 * What a memory record is: an entity (a graph node: person, service, file, concept),
 * a fact (a typed (subject, predicate, object) statement about entities), or a note
 * (free-form durable knowledge: a decision, constraint, preference, or lesson).
 */
export const Kind = Schema.Literals(["entity", "fact", "note"]).annotate({ identifier: "Memory.Kind" })
export type Kind = typeof Kind.Type

/** Supersession, not deletion: an overwritten record stays queryable history. */
export const Status = Schema.Literals(["current", "superseded"]).annotate({ identifier: "Memory.Status" })
export type Status = typeof Status.Type

/** Who wrote the record: the model through a tool, or the automatic capture review. */
export const Source = Schema.Literals(["tool", "capture"]).annotate({ identifier: "Memory.Source" })
export type Source = typeof Source.Type

/** How a search hit was found, so callers can judge provenance. */
export const Via = Schema.Literals(["fts", "semantic", "graph"]).annotate({ identifier: "Memory.Via" })
export type Via = typeof Via.Type

export interface Triple extends Schema.Schema.Type<typeof Triple> {}
export const Triple = Schema.Struct({
  subject: Schema.String.annotate({ description: "Entity the statement is about" }),
  predicate: Schema.String.annotate({ description: "Relation, snake_case, e.g. depends_on" }),
  object: Schema.String.annotate({ description: "Other entity or literal value" }),
}).annotate({ identifier: "Memory.Triple" })

export interface Node extends Schema.Schema.Type<typeof Node> {}
export const Node = Schema.Struct({
  id: Schema.String,
  kind: Kind,
  /** Short label: the entity name, or a one-line summary of a fact or note. */
  title: Schema.String,
  /** Free-form content for notes; facts carry their triple instead. */
  text: optional(Schema.String),
  triple: optional(Triple),
  status: Status,
  /** 0..1: how much the writer trusted the claim. */
  confidence: Schema.Number,
  /** 0..1: how central the record is to the project, used for the always-injected card. */
  importance: Schema.Number,
  source: Source,
  /** Session that wrote the record, when one did. */
  sessionID: optional(Schema.String),
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
}).annotate({ identifier: "Memory.Node" })

export interface Edge extends Schema.Schema.Type<typeof Edge> {}
export const Edge = Schema.Struct({
  id: Schema.String,
  /** Entity node id. */
  source: Schema.String,
  /** Relation, snake_case, e.g. depends_on. */
  relation: Schema.String,
  /** Entity node id. */
  target: Schema.String,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
}).annotate({ identifier: "Memory.Edge" })

export interface Match extends Schema.Schema.Type<typeof Match> {}
export const Match = Schema.Struct({
  node: Node,
  score: Schema.Number,
  via: Via,
  /** The matched current node this record was superseded by, when showing history. */
  supersededBy: optional(Schema.String),
}).annotate({ identifier: "Memory.Match" })

export interface Overview extends Schema.Schema.Type<typeof Overview> {}
export const Overview = Schema.Struct({
  /** Bounded, formatted block of the most important current records for prompt injection. */
  card: Schema.String,
  nodes: Schema.Array(Node),
  counts: Schema.Struct({
    entities: Schema.Number,
    facts: Schema.Number,
    notes: Schema.Number,
    edges: Schema.Number,
  }),
}).annotate({ identifier: "Memory.Overview" })

export interface Search extends Schema.Schema.Type<typeof Search> {}
export const Search = Schema.Struct({
  matches: Schema.Array(Match),
  /** One-hop graph neighborhood of the top matches. */
  related: Schema.Array(Node),
  edges: Schema.Array(Edge),
}).annotate({ identifier: "Memory.Search" })

export interface Neighbors extends Schema.Schema.Type<typeof Neighbors> {}
export const Neighbors = Schema.Struct({
  node: Node,
  nodes: Schema.Array(Node),
  edges: Schema.Array(Edge),
}).annotate({ identifier: "Memory.Neighbors" })

export interface ListPage extends Schema.Schema.Type<typeof ListPage> {}
export const ListPage = Schema.Struct({
  nodes: Schema.Array(Node),
  after: optional(Schema.String),
}).annotate({ identifier: "Memory.ListPage" })

/**
 * The `opencode.memory` plugin's RPC. Clients render the project knowledge graph with `overview`,
 * `search`, `nodes`, and `neighbors`, follow `changed` for live updates, and remove records with
 * `forget`. Reads never load the model: no LLM runs on any method. The schemas are Standard
 * Schemas too, so Promise clients can call it.
 */
export const Definition = Rpc.define({
  id: "opencode.memory",
  methods: {
    overview: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Overview),
    },
    search: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({ query: Schema.String, limit: optional(Schema.Number) }),
      ),
      output: Schema.toStandardSchemaV1(Search),
    },
    nodes: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({ after: optional(Schema.String), limit: optional(Schema.Number) }),
      ),
      output: Schema.toStandardSchemaV1(ListPage),
    },
    neighbors: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String })),
      output: Schema.toStandardSchemaV1(Neighbors),
    },
    forget: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.Boolean),
    },
  },
  events: {
    changed: {
      schema: Schema.toStandardSchemaV1(Schema.Struct({})),
    },
  },
})
