export * as Memory from "./index.js"

import path from "node:path"
import { Buffer } from "node:buffer"
import { and, count, desc, eq, gt, or, sql, type SQLWrapper } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { Config } from "../config.js"
import { Database } from "../database/database.js"
import { KV } from "../kv.js"
import { Location } from "../location.js"
import { MemoryLocal } from "./local.js"
import { MemoryEdgeTable, MemoryNodeTable } from "./sql.js"
import { Global } from "@opencode/util/global"
import type { Memory as MemoryContract } from "@opencode/schema/memory"

type EmbeddingSettingsShape = {
  readonly mode?: "auto" | "remote" | "local" | "off"
  readonly url?: string
  readonly model?: string
  readonly localModel?: string
}

export type Node = MemoryContract.Node
export type Edge = MemoryContract.Edge
export type Match = MemoryContract.Match
export type Overview = MemoryContract.Overview
export type Search = MemoryContract.Search
export type Neighbors = MemoryContract.Neighbors
export type ListPage = MemoryContract.ListPage
export type Kind = MemoryContract.Kind
export type Source = MemoryContract.Source

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Memory.NotFoundError", {
  id: Schema.String,
}) {
  override get message() {
    return `Memory record not found: ${this.id}`
  }
}

export interface RememberInput {
  readonly kind: Kind
  readonly title: string
  readonly text?: string
  readonly triple?: MemoryContract.Triple
  /** Typed links from this record's subject (or itself, for notes) to other entities by name. */
  readonly relations?: ReadonlyArray<{ readonly relation: string; readonly to: string }>
  readonly confidence?: number
  readonly importance?: number
  readonly source: Source
  readonly sessionID?: string
}

export interface LinkInput {
  readonly from: string
  readonly relation: string
  readonly to: string
}

export interface Interface {
  /** Idempotent by content: duplicates return the existing record; a changed fact supersedes the old one. */
  readonly remember: (input: RememberInput) => Effect.Effect<Node>
  readonly link: (input: LinkInput) => Effect.Effect<Edge>
  /** Keyword (FTS5) + optional semantic recall, expanded one hop through the graph. */
  readonly search: (input: { readonly query: string; readonly limit?: number }) => Effect.Effect<Search>
  readonly overview: (input?: { readonly limit?: number }) => Effect.Effect<Overview>
  readonly neighbors: (id: string) => Effect.Effect<Neighbors, NotFoundError>
  readonly list: (input: { readonly after?: string; readonly limit?: number }) => Effect.Effect<ListPage>
  /** Soft delete: the record becomes history, matching how superseded facts are kept. */
  readonly forget: (id: string) => Effect.Effect<boolean>
  /** Effective embedding-source state for the settings UI, including local-model download progress. */
  readonly embeddingInfo: () => Effect.Effect<MemoryContract.EmbeddingInfo>
  /** Probe an OpenAI-compatible endpoint from the server: served models and a test embedding. */
  readonly embeddingCheck: (input: {
    readonly url?: string
    readonly model?: string
  }) => Effect.Effect<MemoryContract.EmbeddingProbe>
  /** Persist the machine-wide embedding preference; merged into the stored settings, then re-resolved. */
  readonly embeddingSet: (input: {
    readonly mode?: "auto" | "remote" | "local" | "off"
    readonly url?: string
    readonly model?: string
    readonly localModel?: string
  }) => Effect.Effect<MemoryContract.EmbeddingInfo>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Memory") {}

const MAX_TITLE = 300
const MAX_TEXT = 4_000
const CARD_CHAR_LIMIT = 1_600
const FTS_TERMS = 12
/** Current records a semantic pass may scan; graph memory stays small by design. */
const EMBEDDING_SCAN_LIMIT = 10_000
const DEFAULT_EMBEDDING_URL = "http://127.0.0.1:8000/v1"
const EMBEDDING_TIMEOUT = "10 seconds"
const EMBEDDING_SETTINGS_KEY = "memory.embedding"
const EMBEDDING_TAG_PREFIX = "memory.embedding.tag."

const ModelsResponse = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) })
const EmbeddingsRequest = Schema.Struct({ model: Schema.String, input: Schema.Array(Schema.String) })
const EmbeddingsResponse = Schema.Struct({
  data: Schema.Array(Schema.Struct({ embedding: Schema.Array(Schema.Number) })),
})

type EmbedSource = { readonly kind: "remote"; readonly url: string; readonly model: string } | { readonly kind: "local"; readonly model: string }

/** Narrow the untrusted kv JSON back to the stored embedding settings; anything else reads as unset. */
function readEmbeddingSettings(value: unknown): EmbeddingSettingsShape | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const text = (field: string) => (typeof record[field] === "string" ? (record[field] as string) : undefined)
  const mode = text("mode")
  const settings: EmbeddingSettingsShape = {
    mode: mode === "auto" || mode === "remote" || mode === "local" || mode === "off" ? mode : undefined,
    url: text("url"),
    model: text("model"),
    localModel: text("localModel"),
  }
  return settings.mode === undefined && settings.url === undefined && settings.model === undefined && settings.localModel === undefined
    ? undefined
    : settings
}

const clamp = (value: number | undefined, fallback: number) =>
  value === undefined ? fallback : Math.min(Math.max(value, 0), 1)

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ")

// Memory content is re-injected into prompts, so strip the invisible characters used to hide
// injection payloads and refuse to store credential shapes that could be exfiltrated later.
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\u2060\ufeff]/g
const CREDENTIALS = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:sk|pk)_live_[A-Za-z0-9]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
]

function sanitize(value: string) {
  const stripped = value.replace(INVISIBLE, "").trim()
  return CREDENTIALS.reduce((text, pattern) => text.replace(pattern, "[redacted]"), stripped)
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** One-line rendering used by the injected card and tool summaries. */
export function describe(node: Pick<Node, "title" | "text" | "triple">) {
  return node.triple
    ? `${node.triple.subject} ${node.triple.predicate.replace(/_/g, " ")} ${node.triple.object}`
    : node.title + (node.text ? `: ${node.text}` : "")
}

const id = () => crypto.randomUUID()

type Row = typeof MemoryNodeTable.$inferSelect
type EdgeRow = typeof MemoryEdgeTable.$inferSelect

// Rows arrive both as query results and as freshly built insert drafts. The drafts fill every
// column, but the draft type marks defaulted columns optional, so read them through the select
// shape.
const toNode = (row: Row | typeof MemoryNodeTable.$inferInsert): Node => {
  const record = row as Row
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    text: record.text ?? undefined,
    triple:
      record.subject != null && record.predicate != null && record.object != null
        ? { subject: record.subject, predicate: record.predicate, object: record.object }
        : undefined,
    status: record.status,
    confidence: record.confidence,
    importance: record.importance,
    source: record.source,
    sessionID: record.session_id ?? undefined,
    timeCreated: record.time_created,
    timeUpdated: record.time_updated,
  }
}

const toEdge = (row: EdgeRow): Edge => ({
  id: row.id,
  source: row.source,
  relation: row.relation,
  target: row.target,
  timeCreated: row.time_created,
  timeUpdated: row.time_updated,
})

const inIds = (values: ReadonlyArray<string>, column: SQLWrapper = MemoryNodeTable.id) =>
  values.length === 0 ? sql`0` : sql`${column} IN (${sql.join(values.map((value) => sql`${value}`), sql`, `)})`

function decodeVector(stored: Uint8Array) {
  return new Float32Array(stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength))
}

function cosine(a: Float32Array, b: Float32Array) {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let norm = 0
  let other = 0
  for (let index = 0; index < length; index++) {
    dot += a[index] * b[index]
    norm += a[index] * a[index]
    other += b[index] * b[index]
  }
  if (norm === 0 || other === 0) return 0
  return dot / Math.sqrt(norm * other)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const location = yield* Location.Service
    const config = yield* Config.Service
    const global = yield* Global.Service
    const kv = yield* KV.Service
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const projectID = location.project.id
    const scope = yield* Effect.scope
    // The embedding source is resolved once per location boot. An unreachable endpoint is resolved
    // to its fallback (local model, then keyword-only) once as well, so recall never probes per
    // operation.
    let embedding: Option.Option<EmbedSource> | undefined
    let backfillStarted = false

    // Stored settings are machine-wide: the embedding endpoint or local model choice belongs to
    // the machine, not one project.
    const readSettings = Effect.fn("Memory.readSettings")(function* () {
      const stored = readEmbeddingSettings(yield* kv.get(EMBEDDING_SETTINGS_KEY))
      const memory = Config.latest(yield* config.entries(), "experimental")?.memory
      const configured = typeof memory === "object" ? memory.embedding : undefined
      return {
        stored,
        mode: stored?.mode ?? "auto",
        url: stored?.url ?? configured?.url ?? DEFAULT_EMBEDDING_URL,
        model: stored?.model ?? configured?.model,
        localModel: stored?.localModel ?? MemoryLocal.DEFAULT_LOCAL_MODEL,
        from: stored !== undefined ? ("stored" as const) : configured?.url !== undefined ? ("config" as const) : ("default" as const),
      }
    })

    const probe = Effect.fn("Memory.probe")(function* (base: string) {
      const models = yield* http
        .execute(HttpClientRequest.get(`${base}/models`).pipe(HttpClientRequest.acceptJson))
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(ModelsResponse)),
          Effect.timeout(EMBEDDING_TIMEOUT),
          Effect.catch(() => Effect.succeed(undefined)),
        )
      if (models === undefined) return Option.none<EmbedSource>()
      const served = models.data.map((model) => model.id)
      // A server serving only one model probably serves it as embeddings.
      const model = served.find((name) => /embed/i.test(name)) ?? (served.length === 1 ? served[0] : undefined)
      return model === undefined ? Option.none<EmbedSource>() : Option.some<EmbedSource>({ kind: "remote", url: base, model })
    })

    // When the resolved source changed since records were last embedded (first boot with local
    // vectors after an upgrade, or a settings change), re-embed current records in the background
    // so semantic search spans the whole graph, not only new records.
    // The explicit type ends the embed → embedder → backfill → embed inference cycle.
    const backfill: (key: string) => Effect.Effect<void> = Effect.fn("Memory.backfill")(function* (key: string) {
      const tagKey = `${EMBEDDING_TAG_PREFIX}${projectID}`
      if ((yield* kv.get(tagKey)) === key) return
      const rows = yield* db
        .select({
          id: MemoryNodeTable.id,
          title: MemoryNodeTable.title,
          text: MemoryNodeTable.text,
          subject: MemoryNodeTable.subject,
          predicate: MemoryNodeTable.predicate,
          object: MemoryNodeTable.object,
        })
        .from(MemoryNodeTable)
        .where(eq(MemoryNodeTable.status, "current"))
        .all()
        .pipe(Effect.orDie)
      const ids = rows.map((row) => row.id)
      const texts = rows.map((row) =>
        [row.title, row.text, row.subject === null ? "" : `${row.subject} ${row.predicate ?? ""} ${row.object ?? ""}`]
          .filter((part): part is string => part !== null && part !== "")
          .join(". "),
      )
      for (let index = 0; index < ids.length; index += 32) {
        const vectors = yield* embed(texts.slice(index, index + 32))
        if (vectors === undefined) break
        for (let offset = 0; offset < vectors.length; offset++) {
          const vector = vectors[offset]
          if (vector === undefined) continue
          yield* db
            .update(MemoryNodeTable)
            .set({ embedding: Buffer.from(vector.buffer) })
            .where(eq(MemoryNodeTable.id, ids[index + offset]!))
            .run()
            .pipe(Effect.orDie)
        }
      }
      yield* kv.set(tagKey, key)
    })

    const embedder = Effect.fn("Memory.embedder")(function* () {
      if (embedding !== undefined) return embedding
      const settings = yield* readSettings()
      let next: Option.Option<EmbedSource> = Option.none()
      let key = "off"
      if (settings.mode === "remote") {
        next = yield* probe(settings.url)
        key = `remote:${settings.url}`
      } else if (settings.mode === "local") {
        next = Option.some<EmbedSource>({ kind: "local", model: settings.localModel })
        key = `local:${settings.localModel}`
      } else if (settings.mode === "auto") {
        const remote = yield* probe(settings.url)
        // With an explicit model there is nothing to probe; trust the configured endpoint.
        next = settings.model !== undefined ? Option.some<EmbedSource>({ kind: "remote", url: settings.url, model: settings.model }) : Option.isSome(remote) ? remote : Option.some<EmbedSource>({ kind: "local", model: settings.localModel })
        key = Option.isSome(next) && next.value.kind === "remote" ? `remote:${next.value.url}#${next.value.model}` : `local:${settings.localModel}`
      }
      embedding = next
      if (Option.isSome(next) && !backfillStarted) {
        backfillStarted = true
        yield* backfill(key).pipe(Effect.catchCause(() => Effect.void), Effect.forkIn(scope))
      }
      return next
    })

    // Embedding failures never fail a memory operation; the caller gets no vector and stores
    // the record without one.
    const embed = Effect.fn("Memory.embed")(function* (texts: ReadonlyArray<string>) {
      if (texts.length === 0) return undefined
      const resolved = yield* embedder()
      if (Option.isNone(resolved)) return undefined
      if (resolved.value.kind === "local")
        return (yield* MemoryLocal.embed(texts, resolved.value.model, path.join(global.data, "memory")))?.map((vector) => Float32Array.from(vector))
      const result = yield* HttpClientRequest.post(`${resolved.value.url}/embeddings`)
        .pipe(
          HttpClientRequest.schemaBodyJson(EmbeddingsRequest)({ model: resolved.value.model, input: texts }),
          Effect.flatMap((request) => http.execute(request)),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(EmbeddingsResponse)),
          Effect.timeout(EMBEDDING_TIMEOUT),
          Effect.asSome,
          Effect.catch(() => Effect.succeed(Option.none())),
        )
      if (Option.isNone(result) || result.value.data.length !== texts.length) return undefined
      return result.value.data.map((item) => Float32Array.from(item.embedding))
    })

    const embedOne = (text: string) => embed([text]).pipe(Effect.map((vectors) => vectors?.[0]))

    // FTS5 is a virtual table drizzle cannot express; create it and its sync triggers on boot.
    yield* Effect.all([
      db.run(sql`CREATE VIRTUAL TABLE IF NOT EXISTS memory_node_fts USING fts5(
        title, text, subject, object, content='memory_node', content_rowid='rowid'
      )`).pipe(Effect.orDie),
      db.run(sql`CREATE TRIGGER IF NOT EXISTS memory_node_ai AFTER INSERT ON memory_node BEGIN
        INSERT INTO memory_node_fts(rowid, title, text, subject, object)
        VALUES (new.rowid, new.title, new.text, new.subject, new.object);
      END`).pipe(Effect.orDie),
      db.run(sql`CREATE TRIGGER IF NOT EXISTS memory_node_ad AFTER DELETE ON memory_node BEGIN
        INSERT INTO memory_node_fts(memory_node_fts, rowid, title, text, subject, object)
        VALUES ('delete', old.rowid, old.title, old.text, old.subject, old.object);
      END`).pipe(Effect.orDie),
      db.run(sql`CREATE TRIGGER IF NOT EXISTS memory_node_au AFTER UPDATE ON memory_node BEGIN
        INSERT INTO memory_node_fts(memory_node_fts, rowid, title, text, subject, object)
        VALUES ('delete', old.rowid, old.title, old.text, old.subject, old.object);
        INSERT INTO memory_node_fts(rowid, title, text, subject, object)
        VALUES (new.rowid, new.title, new.text, new.subject, new.object);
      END`).pipe(Effect.orDie),
    ]).pipe(Effect.asVoid)

    const nodeRows = (ids: ReadonlyArray<string>) =>
      ids.length === 0
        ? Effect.succeed([] as Row[])
        : db
            .select()
            .from(MemoryNodeTable)
            .where(inIds(ids))
            .all()
            .pipe(Effect.orDie)

    // Entity nodes are addressed by lower-cased title, so the same thing written twice lands once.
    const ensureEntity = Effect.fnUntraced(function* (name: string, now: number) {
      const wanted = sanitize(name)
      if (wanted.length === 0) return undefined
      const existing = yield* db
        .select()
        .from(MemoryNodeTable)
        .where(
          and(
            eq(MemoryNodeTable.project_id, projectID),
            eq(MemoryNodeTable.kind, "entity"),
            sql`lower(${MemoryNodeTable.title}) = lower(${wanted})`,
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (existing) return existing
      const row: typeof MemoryNodeTable.$inferInsert = {
        id: id(),
        project_id: projectID,
        kind: "entity",
        title: truncate(wanted, MAX_TITLE),
        text: null,
        subject: null,
        predicate: null,
        object: null,
        status: "current",
        confidence: 0.75,
        importance: 0.5,
        source: "tool",
        session_id: null,
        embedding: null,
        time_created: now,
        time_updated: now,
      }
      yield* db.insert(MemoryNodeTable).values(row).onConflictDoNothing().run().pipe(Effect.orDie)
      return (
        (yield* db
          .select()
          .from(MemoryNodeTable)
          .where(
            and(
              eq(MemoryNodeTable.project_id, projectID),
              eq(MemoryNodeTable.kind, "entity"),
              sql`lower(${MemoryNodeTable.title}) = lower(${wanted})`,
            ),
          )
          .get()
          .pipe(Effect.orDie)) ?? row
      )
    })

    const edgeTo = Effect.fnUntraced(function* (
      from: Pick<Row, "id">,
      relation: string,
      toName: string,
      now: number,
    ) {
      const target = yield* ensureEntity(toName, now)
      if (target === undefined) return
      yield* db
        .insert(MemoryEdgeTable)
        .values({
          id: id(),
          project_id: projectID,
          source: from.id,
          relation: truncate(normalize(relation) || "related_to", 200),
          target: target.id,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    })

    const remember = Effect.fn("Memory.remember")(function* (input: RememberInput) {
      const now = Date.now()
      const text = input.text === undefined ? undefined : truncate(sanitize(input.text), MAX_TEXT)
      const triple = input.triple
        ? {
            subject: truncate(sanitize(input.triple.subject), MAX_TITLE),
            predicate: normalize(sanitize(input.triple.predicate)) || "related_to",
            object: truncate(sanitize(input.triple.object), MAX_TEXT),
          }
        : undefined
      // Facts may arrive without a title; it is then rendered from the triple.
      const given = sanitize(input.title)
      const title = truncate(
        given.length > 0 || triple === undefined
          ? given
          : `${triple.subject} ${triple.predicate.replaceAll("_", " ")} ${triple.object}`,
        MAX_TITLE,
      )
      if (title.length === 0) return yield* Effect.die(new Error("Memory records need a non-empty title"))
      const confidence = clamp(input.confidence, 0.75)
      const importance = clamp(input.importance, 0.5)

      if (input.kind === "entity") {
        const row = yield* ensureEntity(input.title, now)
        if (row === undefined) return yield* Effect.die(new Error("Memory entities need a non-empty title"))
        return toNode(row)
      }

      // Facts supersede by (subject, predicate): the newest object is the current truth, and an
      // identical current fact is a no-op.
      if (triple) {
        const current = yield* db
          .select()
          .from(MemoryNodeTable)
          .where(
            and(
              eq(MemoryNodeTable.project_id, projectID),
              eq(MemoryNodeTable.kind, "fact"),
              eq(MemoryNodeTable.status, "current"),
              sql`lower(${MemoryNodeTable.subject}) = lower(${triple.subject})`,
              sql`lower(${MemoryNodeTable.predicate}) = lower(${triple.predicate})`,
            ),
          )
          .all()
          .pipe(Effect.orDie)
        const same = current.find((row) => normalize(row.object ?? "") === normalize(triple.object))
        if (same) return toNode(same)
        const subject = yield* ensureEntity(triple.subject, now)
        const object = yield* ensureEntity(triple.object, now)
        if (subject) {
          if (object) yield* edgeTo(subject, triple.predicate, object.title, now)
          for (const relation of input.relations ?? []) yield* edgeTo(subject, relation.relation, relation.to, now)
        }
        if (current.length > 0)
          yield* db
            .update(MemoryNodeTable)
            .set({ status: "superseded", time_updated: now })
            .where(inIds(current.map((row) => row.id)))
            .run()
            .pipe(Effect.orDie)
        const row = insert({
          kind: "fact",
          title,
          text,
          triple,
          confidence,
          importance,
          source: input.source,
          sessionID: input.sessionID,
          now,
        })
        yield* insertWithEmbedding(row, `${title}. ${triple.subject} ${triple.predicate} ${triple.object}`)
        return toNode(row)
      }

      const exact = yield* db
        .select()
        .from(MemoryNodeTable)
        .where(
          and(
            eq(MemoryNodeTable.project_id, projectID),
            eq(MemoryNodeTable.kind, input.kind),
            eq(MemoryNodeTable.status, "current"),
            sql`lower(${MemoryNodeTable.title}) = lower(${title})`,
          ),
        )
        .get()
        .pipe(Effect.orDie)
      // A note rewritten with the same title updates in place rather than superseding itself.
      if (exact) {
        const vector = yield* embedOne(`${title}. ${text ?? ""}`)
        yield* db
          .update(MemoryNodeTable)
          .set({
            text,
            confidence,
            importance,
            source: input.source,
            embedding: vector === undefined ? null : Buffer.from(vector.buffer),
            time_updated: now,
          })
          .where(eq(MemoryNodeTable.id, exact.id))
          .run()
          .pipe(Effect.orDie)
        for (const relation of input.relations ?? []) yield* edgeTo(exact, relation.relation, relation.to, now)
        return toNode({ ...exact, text: text ?? null, confidence, importance, source: input.source, time_updated: now })
      }
      const row = insert({
        kind: input.kind,
        title,
        text,
        confidence,
        importance,
        source: input.source,
        sessionID: input.sessionID,
        now,
      })
      yield* insertWithEmbedding(row, `${title}. ${text ?? ""}`)
      for (const relation of input.relations ?? []) yield* edgeTo({ id: row.id }, relation.relation, relation.to, now)
      return toNode(row)
    })

    function insert(base: {
      kind: Kind
      title: string
      text: string | undefined
      triple?: MemoryContract.Triple
      confidence: number
      importance: number
      source: Source
      sessionID: string | undefined
      now: number
    }): typeof MemoryNodeTable.$inferInsert {
      return {
        id: id(),
        project_id: projectID,
        kind: base.kind,
        title: base.title,
        text: base.text ?? null,
        subject: base.triple?.subject ?? null,
        predicate: base.triple?.predicate ?? null,
        object: base.triple?.object ?? null,
        status: "current",
        confidence: base.confidence,
        importance: base.importance,
        source: base.source,
        session_id: base.sessionID ?? null,
        embedding: null,
        time_created: base.now,
        time_updated: base.now,
      }
    }

    const insertWithEmbedding = (row: typeof MemoryNodeTable.$inferInsert, text: string) =>
      embedOne(text).pipe(
        Effect.flatMap((vector) =>
          db
            .insert(MemoryNodeTable)
            .values({ ...row, embedding: vector === undefined ? undefined : Buffer.from(vector.buffer) })
            .run(),
        ),
        Effect.orDie,
      )

    const link = Effect.fn("Memory.link")(function* (input: LinkInput) {
      const now = Date.now()
      const from = yield* ensureEntity(input.from, now)
      const to = yield* ensureEntity(input.to, now)
      if (!from || !to) return yield* Effect.die(new Error("link endpoints need non-empty names"))
      const relation = truncate(normalize(input.relation) || "related_to", 200)
      yield* db
        .insert(MemoryEdgeTable)
        .values({
          id: id(),
          project_id: projectID,
          source: from.id,
          relation,
          target: to.id,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const row = yield* db
        .select()
        .from(MemoryEdgeTable)
        .where(
          and(
            eq(MemoryEdgeTable.project_id, projectID),
            eq(MemoryEdgeTable.source, from.id),
            sql`lower(${MemoryEdgeTable.relation}) = lower(${relation})`,
            eq(MemoryEdgeTable.target, to.id),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die(new Error("edge vanished after insert"))
      return toEdge(row)
    })

    // bm25 is negative and lower-is-better; flip it into a descending 0..1 relevance.
    const ftsMatches = Effect.fn("Memory.ftsMatches")(function* (query: string, limit: number) {
      const terms = query
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((term) => term.length > 0)
        .slice(0, FTS_TERMS)
      if (terms.length === 0) return [] as Array<{ node: Node; score: number }>
      // An OR of quoted phrases keeps recall high and survives punctuation in the query. The last
      // term gets a prefix match outside its quotes so partial identifiers still hit.
      const match = terms
        .map(
          (term, index) =>
            `"${term.replaceAll('"', "")}"${index === terms.length - 1 && term.length >= 3 ? "*" : ""}`,
        )
        .join(" OR ")
      const rows = yield* db
        .all<Row & { score: number }>(sql`
          SELECT n.*, bm25(memory_node_fts) AS score
          FROM memory_node_fts
          JOIN memory_node n ON n.rowid = memory_node_fts.rowid
          WHERE memory_node_fts MATCH ${match} AND n.project_id = ${projectID} AND n.status = 'current'
          ORDER BY score
          LIMIT ${limit * 2}
        `)
        .pipe(Effect.orDie)
      return rows.map((row) => ({ node: toNode(row), score: 1 / (1 + Math.max(0, -row.score)) }))
    })

    const semanticMatches = Effect.fn("Memory.semanticMatches")(function* (query: string, limit: number) {
      const queryVector = yield* embedOne(query)
      if (queryVector === undefined) return [] as Array<{ node: Node; score: number }>
      const rows = yield* db
        .select()
        .from(MemoryNodeTable)
        .where(and(eq(MemoryNodeTable.project_id, projectID), eq(MemoryNodeTable.status, "current")))
        .limit(EMBEDDING_SCAN_LIMIT)
        .all()
        .pipe(Effect.orDie)
      return rows
        .filter((row) => row.embedding !== null)
        .map((row) => ({ node: toNode(row), score: cosine(queryVector, decodeVector(row.embedding!)) }))
        .filter((match) => match.score > 0.2)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit * 3)
    })

    // One-hop neighborhood: facts linking to an entity's name, edges touching it, and the rows
    // on the other side of those edges.
    const expand = Effect.fnUntraced(function* (seeds: ReadonlyArray<Row>) {
      if (seeds.length === 0) return { nodes: [] as Node[], edges: [] as Edge[] }
      const names = seeds.flatMap((row) =>
        row.kind === "entity" ? [row.title] : row.subject !== null && row.object !== null ? [row.subject, row.object] : [],
      )
      const related = new Map<string, Node>()
      const edges = new Map<string, Edge>()
      if (names.length > 0) {
        const facts = yield* db
          .select()
          .from(MemoryNodeTable)
          .where(
            and(
              eq(MemoryNodeTable.project_id, projectID),
              eq(MemoryNodeTable.status, "current"),
              eq(MemoryNodeTable.kind, "fact"),
              or(inIds(names, MemoryNodeTable.subject), inIds(names, MemoryNodeTable.object))!,
            ),
          )
          .limit(100)
          .all()
          .pipe(Effect.orDie)
        facts.forEach((row) => related.set(row.id, toNode(row)))
        const entities = yield* db
          .select()
          .from(MemoryNodeTable)
          .where(
            and(
              eq(MemoryNodeTable.project_id, projectID),
              eq(MemoryNodeTable.status, "current"),
              eq(MemoryNodeTable.kind, "entity"),
              inIds(names, MemoryNodeTable.title),
            ),
          )
          .limit(100)
          .all()
          .pipe(Effect.orDie)
        entities.forEach((row) => related.set(row.id, toNode(row)))
        const links = yield* db
          .select()
          .from(MemoryEdgeTable)
          .where(
            and(
              eq(MemoryEdgeTable.project_id, projectID),
              or(inIds(seeds.map((row) => row.id), MemoryEdgeTable.source), inIds(seeds.map((row) => row.id), MemoryEdgeTable.target))!,
            ),
          )
          .limit(100)
          .all()
          .pipe(Effect.orDie)
        links.forEach((row) => edges.set(row.id, toEdge(row)))
        yield* nodeRows([
          ...new Set(links.flatMap((link) => [link.source, link.target]).values()),
        ]).pipe(Effect.map((rows) => rows.forEach((row) => related.set(row.id, toNode(row)))))
      }
      seeds.forEach((row) => related.delete(row.id))
      return { nodes: [...related.values()], edges: [...edges.values()] }
    })

    const search = Effect.fn("Memory.search")(function* (input: { query: string; limit?: number }) {
      const limit = Math.min(Math.max(Math.floor(input.limit ?? 8), 1), 50)
      const query = sanitize(input.query)
      const [keyword, semantic] = yield* Effect.all([ftsMatches(query, limit), semanticMatches(query, limit)], {
        concurrency: 2,
      })
      // Reciprocal-rank fusion: the two score scales are not comparable, their ranks are.
      const fused = new Map<string, { node: Node; score: number; via: "fts" | "semantic" }>()
      for (const [rankings, via] of [
        [keyword, "fts"],
        [semantic, "semantic"],
      ] as const)
        rankings
          .sort((a, b) => b.score - a.score)
          .forEach((match, index) => {
            const prior = fused.get(match.node.id)
            const rrf = 1 / (60 + index + 1)
            if (prior) fused.set(match.node.id, { node: match.node, score: prior.score + rrf, via: prior.via })
            else fused.set(match.node.id, { node: match.node, score: rrf, via })
          })
      const matches = [...fused.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((match) => ({ node: match.node, score: match.score, via: match.via }))
      const neighborhood = yield* expand(yield* nodeRows(matches.map((match) => match.node.id)))
      return { matches, related: neighborhood.nodes, edges: neighborhood.edges }
    })

    const kindCounts = Effect.fnUntraced(function* () {
      const rows = yield* db
        .select({ kind: MemoryNodeTable.kind, total: count() })
        .from(MemoryNodeTable)
        .where(and(eq(MemoryNodeTable.project_id, projectID), eq(MemoryNodeTable.status, "current")))
        .groupBy(MemoryNodeTable.kind)
        .all()
        .pipe(Effect.orDie)
      const edges = yield* db
        .select({ total: count() })
        .from(MemoryEdgeTable)
        .where(eq(MemoryEdgeTable.project_id, projectID))
        .get()
        .pipe(Effect.orDie)
      const byKind = Object.fromEntries(rows.map((row) => [row.kind, row.total])) as Record<Kind, number>
      return { entities: byKind.entity ?? 0, facts: byKind.fact ?? 0, notes: byKind.note ?? 0, edges: edges?.total ?? 0 }
    })

    const overview = Effect.fn("Memory.overview")(function* (input?: { limit?: number }) {
      const limit = Math.min(Math.max(Math.floor(input?.limit ?? 16), 1), 100)
      // Importance with a recency nudge: a 60-day half-life keeps stale-but-important records in.
      const rows = yield* db
        .select()
        .from(MemoryNodeTable)
        .where(and(eq(MemoryNodeTable.project_id, projectID), eq(MemoryNodeTable.status, "current")))
        .orderBy(
          desc(
            sql`(${MemoryNodeTable.importance} * 0.7 + 0.3 * (1.0 / (1.0 + (${Date.now()} - ${MemoryNodeTable.time_updated}) / 5184000000.0)))`,
          ),
        )
        .limit(limit)
        .all()
        .pipe(Effect.orDie)
      const nodes = rows.map(toNode)
      const counts = yield* kindCounts()
      let used = 0
      const lines = nodes.flatMap((node) => {
        const line = `- ${truncate(describe(node), 160)}`
        if (used + line.length > CARD_CHAR_LIMIT) return []
        used += line.length + 1
        return [line]
      })
      const card = lines.length === 0 ? "" : `PROJECT MEMORY (${nodes.length} current records)\n${lines.join("\n")}`
      return { card, nodes, counts }
    })

    const neighbors = Effect.fn("Memory.neighbors")(function* (nodeID: string) {
      const row = (yield* nodeRows([nodeID]))[0]
      if (!row) return yield* new NotFoundError({ id: nodeID })
      const neighborhood = yield* expand([row])
      return { node: toNode(row), nodes: neighborhood.nodes, edges: neighborhood.edges }
    })

    const list = Effect.fn("Memory.list")(function* (input: { after?: string; limit?: number }) {
      const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 200)
      const rows = yield* db
        .select()
        .from(MemoryNodeTable)
        .where(
          and(
            eq(MemoryNodeTable.project_id, projectID),
            input.after === undefined ? undefined : gt(MemoryNodeTable.id, input.after),
          ),
        )
        .orderBy(MemoryNodeTable.time_created, MemoryNodeTable.id)
        .limit(limit + 1)
        .all()
        .pipe(Effect.orDie)
      const page = rows.slice(0, limit)
      return {
        nodes: page.map(toNode),
        ...(rows.length > limit && page.length > 0 ? { after: page[page.length - 1].id } : {}),
      }
    })

    const forget = Effect.fn("Memory.forget")(function* (nodeID: string) {
      const rows = yield* db
        .update(MemoryNodeTable)
        .set({ status: "superseded", time_updated: Date.now() })
        .where(
          and(
            eq(MemoryNodeTable.project_id, projectID),
            eq(MemoryNodeTable.id, nodeID),
            eq(MemoryNodeTable.status, "current"),
          ),
        )
        .returning({ id: MemoryNodeTable.id })
        .all()
        .pipe(Effect.orDie)
      return rows.length > 0
    })

    const embeddingInfo = Effect.fn("Memory.embeddingInfo")(function* () {
      const settings = yield* readSettings()
      const local = MemoryLocal.current()
      return {
        mode: settings.mode,
        source: settings.from,
        url: settings.url,
        model: settings.model,
        localModel: settings.localModel,
        local:
          local.state === "downloading"
            ? { state: local.state, percent: local.percent }
            : local.state === "failed"
              ? { state: local.state, error: local.error }
              : { state: local.state },
      } satisfies MemoryContract.EmbeddingInfo
    })

    // Probe from the server so the settings UI never fetches cross-origin, and prove the endpoint
    // with one real /embeddings call; a /models-only server is not an embeddings server.
    const embeddingCheck = Effect.fn("Memory.embeddingCheck")(function* (input: { url?: string; model?: string }) {
      const base = (input.url ?? DEFAULT_EMBEDDING_URL).replace(/\/+$/, "")
      const models = yield* http
        .execute(HttpClientRequest.get(`${base}/models`).pipe(HttpClientRequest.acceptJson))
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(ModelsResponse)),
          Effect.timeout(EMBEDDING_TIMEOUT),
          Effect.asSome,
          Effect.catch(() => Effect.succeed(Option.none())),
        )
      if (Option.isNone(models)) return { reachable: false, models: [] }
      const served = models.value.data.map((model) => ({
        id: model.id,
        embeddings: /embed/i.test(model.id) || models.value.data.length === 1,
      }))
      const picked = input.model ?? served.find((model) => model.embeddings)?.id
      if (picked === undefined) return { reachable: true, models: served }
      const sample = yield* HttpClientRequest.post(`${base}/embeddings`)
        .pipe(
          HttpClientRequest.schemaBodyJson(EmbeddingsRequest)({ model: picked, input: ["ping"] }),
          Effect.flatMap((request) => http.execute(request)),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(EmbeddingsResponse)),
          Effect.timeout(EMBEDDING_TIMEOUT),
          Effect.as(true),
          // Status codes are erased by filterStatusOk; the exact reason lives in the server logs.
          Effect.catch(() => Effect.succeed("request failed")),
        )
      return { reachable: true, models: served, sample: { model: picked, ok: sample === true, error: sample === true ? undefined : String(sample) } }
    })

    const embeddingSet = Effect.fn("Memory.embeddingSet")(function* (input: EmbeddingSettingsShape) {
      const stored = readEmbeddingSettings(yield* kv.get(EMBEDDING_SETTINGS_KEY))
      const next = { ...stored, ...input }
      const empty = Object.values(next).every((value) => value === undefined)
      if (empty) yield* kv.remove(EMBEDDING_SETTINGS_KEY)
      else yield* kv.set(EMBEDDING_SETTINGS_KEY, next)
      // The next operation re-resolves, re-probes, and re-runs the backfill check under the new key.
      embedding = undefined
      backfillStarted = false
      MemoryLocal.reset()
      // Choosing local should start the model download right away, so the settings page can show
      // its progress; one throwaway embed warms the pipeline without touching any record.
      const warmup = yield* embedder()
      if (Option.isSome(warmup) && warmup.value.kind === "local")
        yield* embed(["warmup"]).pipe(Effect.asVoid, Effect.catchCause(() => Effect.void), Effect.forkIn(scope))
      return yield* embeddingInfo()
    })

    return Service.of({ remember, link, search, overview, neighbors, list, forget, embeddingInfo, embeddingCheck, embeddingSet })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, Location.node, Config.node, Global.node, KV.node, httpClient],
})
