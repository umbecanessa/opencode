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
 * The embedding-endpoint preference. An empty object clears stored choices back to config and
 * defaults. `mode` picks where vectors come from; `url`/`model` steer a remote endpoint;
 * `localModel` names the auto-downloaded model for local mode.
 */
export interface EmbeddingSettings extends Schema.Schema.Type<typeof EmbeddingSettings> {}
export const EmbeddingSettings = Schema.Struct({
  /** auto = remote endpoint if reachable, else the local model; remote = endpoint only; local = built-in model only; off = keyword search only. */
  mode: Schema.optional(Schema.Literals(["auto", "remote", "local", "off"])),
  /** Base URL of an OpenAI-compatible endpoint, e.g. http://192.168.1.9:8000/v1. */
  url: optional(Schema.String),
  /** Model served at that endpoint to embed with. When omitted, the endpoint is probed. */
  model: optional(Schema.String),
  /** HuggingFace model id used for local embeddings. Defaults to a small English BGE model. */
  localModel: optional(Schema.String),
}).annotate({ identifier: "Memory.EmbeddingSettings" })

/** What semantic recall resolves to right now, and how the local model is doing. */
export interface EmbeddingInfo extends Schema.Schema.Type<typeof EmbeddingInfo> {}
export const EmbeddingInfo = Schema.Struct({
  mode: Schema.Literals(["auto", "remote", "local", "off"]).annotate({
    description: "Effective mode: a stored choice, or auto when nothing was chosen",
  }),
  /** Where the mode and endpoint came from: stored settings, project config, or defaults. */
  source: Schema.Literals(["stored", "config", "default"]),
  url: optional(Schema.String),
  model: optional(Schema.String),
  localModel: Schema.String,
  local: Schema.Struct({
    state: Schema.Literals(["idle", "downloading", "ready", "failed"]),
    percent: optional(Schema.Number),
    error: optional(Schema.String),
  }).annotate({ description: "Download/inference readiness of the local model" }),
}).annotate({ identifier: "Memory.EmbeddingInfo" })

/** Result of probing one embedding endpoint from the server, so the browser never fetches cross-origin. */
export interface EmbeddingProbe extends Schema.Schema.Type<typeof EmbeddingProbe> {}
export const EmbeddingProbe = Schema.Struct({
  /** The endpoint answered /models. */
  reachable: Schema.Boolean,
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      /** Name suggests an embeddings model; single-model servers count as one. */
      embeddings: Schema.Boolean,
    }),
  ).annotate({ description: "Models the endpoint serves, best-guess embeddings-capable ones flagged" }),
  /** A real /embeddings call with the picked (or best-guessed) model; absent when none was tried. */
  sample: optional(
    Schema.Struct({
      model: Schema.String,
      ok: Schema.Boolean,
      /** Short failure text when ok is false, e.g. a 404 meaning the server serves no embeddings. */
      error: optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "Memory.EmbeddingProbe" })

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
    /** What semantic recall currently resolves to, including local-model download progress. */
    embedding: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(EmbeddingInfo),
    },
    /** Probe one OpenAI-compatible endpoint from the server: its models and a test embedding. */
    checkEmbedding: {
      input: Schema.toStandardSchemaV1(EmbeddingSettings),
      output: Schema.toStandardSchemaV1(EmbeddingProbe),
    },
    /** Store the embedding preference (pass an empty object to clear it back to defaults). */
    setEmbedding: {
      input: Schema.toStandardSchemaV1(EmbeddingSettings),
      output: Schema.toStandardSchemaV1(EmbeddingInfo),
    },
  },
  events: {
    changed: {
      schema: Schema.toStandardSchemaV1(Schema.Struct({})),
    },
  },
})
