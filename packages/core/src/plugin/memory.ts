export * as MemoryPlugin from "./memory.js"

import { SystemPart, ToolFailure } from "@opencode/ai/effect"
import { define } from "@opencode/plugin/effect/plugin"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Definition, Kind, Status } from "@opencode/schema/memory"
import { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Cause, Effect, Option, Schema } from "effect"
import { Config } from "../config.js"
import { ConfigEntryObserver } from "../config/plugin/entry-observer.js"
import { Memory } from "../memory/index.js"
import { Permission } from "../permission.js"
import REVIEW from "./memory/review.txt"
import SEARCH_DESCRIPTION from "./memory/search.txt"
import WRITE_DESCRIPTION from "./memory/write.txt"

// Capture runs once the Session would go idle, like the goal plugin's reviewer. Keep each review
// bounded: enough transcript to learn from without replaying the whole Session on every call.
const MIN_CAPTURE_CHARS = 600
const MAX_TRANSCRIPT_CHARS = 24_000
const MAX_MESSAGE_CHARS = 700
const MAX_FACTS = 8
const MAX_NOTES = 4
const MAX_LINKS = 8

const Extraction = Schema.Struct({
  facts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        subject: Schema.String,
        predicate: Schema.String,
        object: Schema.String,
        importance: Schema.optional(Schema.Number),
      }),
    ),
  ),
  notes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        title: Schema.String,
        text: Schema.String,
        importance: Schema.optional(Schema.Number),
      }),
    ),
  ),
  links: Schema.optionalKey(
    Schema.Array(Schema.Struct({ from: Schema.String, relation: Schema.String, to: Schema.String })),
  ),
})
const decodeExtraction = Schema.decodeUnknownOption(Schema.fromJsonString(Extraction))

const Ledger = Schema.Struct({ lastMessageID: Schema.optionalKey(Schema.String) })
const decodeLedger = Schema.decodeUnknownOption(Ledger)

export const Plugin = define({
  id: "opencode.memory",
  effect: Effect.fn(function* (ctx: Context) {
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const memory = yield* Memory.Service
    type Messages = Effect.Success<ReturnType<typeof ctx.session.context>>

    // Internal plugins are not re-run on config changes, so reload the tool transform instead.
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.tool.reload())
    // Memory is on by default; projects opt out with `experimental.memory: false`.
    const enabled = () => Config.latest(loaded.entries, "experimental")?.memory !== false

    // The forget handler cannot reference `rpc` inside the registration object (its type is
    // still being inferred there), so the event emitter is wired in right after registration.
    let notify = (): Effect.Effect<void> => Effect.void
    const rpc = yield* ctx.rpc
      .register(Definition, {
        overview: () => memory.overview(),
        search: (input) => memory.search({ query: input.query, limit: input.limit }),
        nodes: (input) => memory.list(input),
        neighbors: (input) => memory.neighbors(input.id).pipe(Effect.orDie),
        forget: (input) => memory.forget(input.id).pipe(Effect.tap((gone) => (gone ? notify() : Effect.void))),
        embedding: () => memory.embeddingInfo(),
        checkEmbedding: (input) => memory.embeddingCheck({ url: input.url, model: input.model }),
        setEmbedding: (input) => memory.embeddingSet({ mode: input.mode, url: input.url, model: input.model, localModel: input.localModel }),
      })
      .pipe(Effect.orDie)

    notify = () => rpc.events.emit("changed", {}).pipe(Effect.ignore, Effect.catchCause(() => Effect.void))
    const announce = Effect.suspend(notify)

    const WriteOperation = Schema.Struct({
      action: Schema.Literals(["remember", "link", "forget"]).annotate({
        description: "remember stores a record; link connects two entities; forget retires a record by id",
      }),
      kind: Schema.optional(Schema.Literals(["entity", "fact", "note"])).annotate({
        description:
          "For remember: entity (a thing), fact (subject-predicate-object), or note (decision, preference, lesson). Defaults to note",
      }),
      title: Schema.optional(Schema.String).annotate({
        description: "Short label for the record; for facts it is rendered from the triple when omitted",
      }),
      text: Schema.optional(Schema.String).annotate({
        description: "Durable content for notes; skip trivia that is cheap to re-discover",
      }),
      subject: Schema.optional(Schema.String).annotate({ description: "Entity the fact is about" }),
      predicate: Schema.optional(Schema.String).annotate({
        description: "Relation in snake_case, e.g. depends_on, decided_to, runs_on",
      }),
      object: Schema.optional(Schema.String).annotate({ description: "Other side of the fact" }),
      from: Schema.optional(Schema.String).annotate({ description: "For link: source entity name" }),
      relation: Schema.optional(Schema.String).annotate({ description: "For link: relation in snake_case" }),
      to: Schema.optional(Schema.String).annotate({
        description: "For link: target entity name. For remember: an entity this record relates to (combine with relation)",
      }),
      id: Schema.optional(Schema.String).annotate({
        description: "For forget: the record id, taken from a memory_search result",
      }),
      confidence: Schema.optional(Schema.Number).annotate({
        description: "0..1 trust in the claim; 1 for directly observed facts, lower for inference",
      }),
      importance: Schema.optional(Schema.Number).annotate({
        description: "0..1 centrality to the project; high-importance records are always visible in context",
      }),
    })

    yield* ctx.tool
      .transform((editor) => {
        if (!enabled()) return
        editor.add({
          name: "memory_search",
          options: { codemode: false },
          description: SEARCH_DESCRIPTION,
          input: Schema.Struct({
            query: Schema.String.annotate({ description: "Words to look up: names, decisions, constraints" }),
            limit: Schema.optional(Schema.Number).annotate({ description: "Maximum matches, default 8" }),
          }),
          output: Schema.Struct({
            matches: Schema.Array(
              Schema.Struct({
                id: Schema.String,
                kind: Kind,
                text: Schema.String,
                status: Status,
                confidence: Schema.Number,
                importance: Schema.Number,
              }),
            ),
            related: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
          }),
          execute: (input) =>
            memory.search({ query: input.query, limit: input.limit }).pipe(
              Effect.map((result) => {
                const lines = result.matches.map(
                  (match) =>
                    `- [${match.node.id}] ${match.node.kind}: ${Memory.describe(match.node)} (${match.node.status}, confidence ${match.node.confidence.toFixed(2)})`,
                )
                const related = result.related.map((node) => `- ~${node.id} ${Memory.describe(node)}`)
                const summary =
                  lines.length === 0
                    ? "No stored project memory matched. Answer from the repo and consider whether anything here is worth remembering."
                    : `Project memory:\n${lines.join("\n")}${related.length ? `\nRelated:\n${related.join("\n")}` : ""}`
                return {
                  output: {
                    matches: result.matches.map((match) => ({
                      id: match.node.id,
                      kind: match.node.kind,
                      text: Memory.describe(match.node),
                      status: match.node.status,
                      confidence: match.node.confidence,
                      importance: match.node.importance,
                    })),
                    related: result.related.map((node) => ({ id: node.id, text: Memory.describe(node) })),
                  },
                  content: summary,
                  metadata: {},
                }
              }),
            ),
        })
        editor.add({
          name: "memory_write",
          options: { codemode: false },
          description: WRITE_DESCRIPTION,
          input: Schema.Struct({
            operations: Schema.Array(WriteOperation).annotate({ description: "Batched writes" }),
          }),
          output: Schema.Struct({ ids: Schema.Array(Schema.String) }),
          execute: (input, context) =>
            permission
              .assert({
                action: "memory_write",
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              .pipe(
                Effect.mapError((error) => new ToolFailure({ message: "Unable to write project memory", error })),
                Effect.andThen(
                  Effect.gen(function* () {
                    const summaries: string[] = []
                    const ids: string[] = []
                    for (const operation of input.operations) {
                      if (operation.action === "link") {
                        if (!operation.from || !operation.to || !operation.relation)
                          return yield* new ToolFailure({ message: "link needs from, relation, and to" })
                        const edge = yield* memory.link({
                          from: operation.from,
                          relation: operation.relation,
                          to: operation.to,
                        })
                        ids.push(edge.id)
                        summaries.push(`linked ${operation.from} ${operation.relation} ${operation.to}`)
                        continue
                      }
                      if (operation.action === "forget") {
                        if (!operation.id) return yield* new ToolFailure({ message: "forget needs an id" })
                        const gone = yield* memory.forget(operation.id)
                        summaries.push(gone ? `retired ${operation.id}` : `nothing to retire for ${operation.id}`)
                        continue
                      }
                      const kind = operation.kind ?? "note"
                      if (kind === "fact" && (!operation.subject || !operation.predicate || !operation.object))
                        return yield* new ToolFailure({
                          message: "fact remembers need subject, predicate, and object",
                        })
                      if (kind !== "fact" && !operation.title)
                        return yield* new ToolFailure({ message: "remember needs a title for entities and notes" })
                      const node = yield* memory.remember({
                        kind,
                        title: operation.title ?? "",
                        text: operation.text,
                        triple:
                          kind === "fact"
                            ? { subject: operation.subject!, predicate: operation.predicate!, object: operation.object! }
                            : undefined,
                        relations:
                          operation.to && operation.relation
                            ? [{ relation: operation.relation, to: operation.to }]
                            : undefined,
                        confidence: operation.confidence,
                        importance: operation.importance,
                        source: "tool",
                        sessionID: String(context.sessionID),
                      })
                      ids.push(node.id)
                      summaries.push(`${node.kind} ${node.id}: ${Memory.describe(node)}`)
                    }
                    yield* announce
                    return { output: { ids }, content: summaries.join("\n"), metadata: {} }
                  }),
                ),
              ),
        })
      })
      .pipe(Effect.orDie)

    // ---- context injection ----
    // Frozen per session on first request, so the prompt-cache prefix stays stable; writes made
    // during the session surface through tool responses instead of a shifting system part.
    const cards = new Map<string, string>()
    const card = (sessionID: string) => {
      const known = cards.get(sessionID)
      if (known !== undefined) return Effect.succeed(known)
      return memory.overview({ limit: 20 }).pipe(
        Effect.map((overview) => {
          const text =
            overview.card === ""
              ? ""
              : `${overview.card}\nThis is the project knowledge graph: durable facts and decisions from past sessions. Verify against the live repo before relying on a record. Use memory_search to look deeper and memory_write to add or retire records. Do not repeat this block back to the user.`
          if (cards.size > 500) cards.clear()
          cards.set(sessionID, text)
          return text
        }),
      )
    }

    yield* ctx.session.hook("context", (event) =>
      enabled()
        ? card(String(event.sessionID)).pipe(
            Effect.map((text) => {
              if (text === "") return
              event.system.push(SystemPart.make(text))
            }),
            Effect.catchCause((cause) => Effect.logWarning("failed to inject project memory", { cause })),
          )
        : Effect.void,
    )

    // ---- automatic capture at idle ----
    yield* ctx.session.hook("experimental.idle", (event) =>
      enabled()
        ? capture(event.sessionID).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("project memory capture failed", { sessionID: event.sessionID, cause }),
            ),
          )
        : Effect.void,
    )

    const capture = Effect.fn("MemoryPlugin.capture")(function* (sessionID: Session.ID) {
      const messages = yield* ctx.session.context({ sessionID })
      const key = `captured:${String(sessionID)}`
      const ledger = Option.getOrUndefined(decodeLedger(yield* ctx.storage.get(key)))
      const through = ledger?.lastMessageID === undefined ? -1 : messages.findLastIndex((m) => String(m.id) === ledger.lastMessageID)
      const transcript = transcriptOf(messages.slice(through + 1), messages)
      const last = messages.at(-1)
      yield* ctx.storage.set(key, { lastMessageID: last === undefined ? "" : String(last.id) })
      if (transcript.length < MIN_CAPTURE_CHARS) return
      const result = yield* ctx.session.generate({ sessionID, prompt: render(REVIEW, { transcript: escapeText(transcript) }) })
      const extraction = parseExtraction(result.text)
      if (extraction === undefined) return
      const written =
        (yield* applyFacts(extraction, sessionID)) + (yield* applyNotes(extraction, sessionID)) + (yield* applyLinks(extraction))
      if (written > 0) yield* announce
    })

    const applyFacts = Effect.fn("MemoryPlugin.applyFacts")(function* (extraction: Extraction, sessionID: Session.ID) {
      const facts = (extraction.facts ?? []).slice(0, MAX_FACTS)
      yield* Effect.forEach(
        facts,
        (fact) =>
          memory.remember({
            kind: "fact",
            title: "",
            triple: { subject: fact.subject, predicate: fact.predicate, object: fact.object },
            importance: fact.importance,
            source: "capture",
            sessionID: String(sessionID),
          }),
        { discard: true },
      )
      return facts.length
    })

    const applyNotes = Effect.fn("MemoryPlugin.applyNotes")(function* (extraction: Extraction, sessionID: Session.ID) {
      const notes = (extraction.notes ?? []).slice(0, MAX_NOTES)
      yield* Effect.forEach(
        notes,
        (note) =>
          memory.remember({
            kind: "note",
            title: note.title,
            text: note.text,
            importance: note.importance,
            source: "capture",
            sessionID: String(sessionID),
          }),
        { discard: true },
      )
      return notes.length
    })

    const applyLinks = Effect.fn("MemoryPlugin.applyLinks")(function* (extraction: Extraction) {
      const links = (extraction.links ?? []).slice(0, MAX_LINKS)
      yield* Effect.forEach(
        links,
        (link) => memory.link({ from: link.from, relation: link.relation, to: link.to }).pipe(Effect.ignore),
        { discard: true },
      )
      return links.length
    })

    function transcriptOf(fresh: Messages, all: Messages) {
      // After a compaction the ledger's message id is gone from the live window; fall back to the
      // tail of what remains so the review still sees something rather than everything.
      const source = fresh.length > 0 ? fresh : all.slice(-12)
      const lines = source.flatMap((message) => {
        const text = messageText(message)
        return text.trim().length === 0 ? [] : [`${roleOf(message.type)}: ${truncate(text.trim(), MAX_MESSAGE_CHARS)}`]
      })
      const joined = lines.join("\n")
      return joined.length > MAX_TRANSCRIPT_CHARS ? joined.slice(-MAX_TRANSCRIPT_CHARS) : joined
    }
  }),
})

type Extraction = Schema.Schema.Type<typeof Extraction>

function roleOf(type: string) {
  if (type === "user") return "USER"
  if (type === "assistant") return "ASSISTANT"
  return "CONTEXT"
}

function messageText(message: SessionMessage.Info) {
  switch (message.type) {
    case "assistant":
      return message.content
        .flatMap((part) =>
          part.type === "text" ? [part.text] : part.type === "tool" ? [`[called ${part.name}]`] : [],
        )
        .join(" ")
    case "user":
    case "synthetic":
    case "system":
    case "skill":
      return message.text
    case "shell":
      return `[ran \`${message.command}\`]`
    case "compaction":
      return message.status === "failed" ? "" : message.summary
    default:
      return ""
  }
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function escapeText(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

// One pass, so a transcript containing a placeholder is not expanded again.
function render(template: string, values: Record<string, string>) {
  return template.replace(/\$\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

// Reviewers sometimes wrap the JSON in a code fence or a sentence.
function parseExtraction(text: string) {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end < start) return undefined
  return Option.getOrUndefined(decodeExtraction(text.slice(start, end + 1)))
}
