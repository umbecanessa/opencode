import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Database } from "@opencode/core/database/database"
import { Location } from "@opencode/core/location"
import { Memory } from "@opencode/core/memory/index"
import { MemoryNodeTable } from "@opencode/core/memory/sql"
import { Project } from "@opencode/core/project"
import { upsertProject } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"

// Embedding calls reach 127.0.0.1 (refused on CI) so the tests run on the real clock.
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Memory.node]), [Location.node.replace(tempLocationLayer)]),
)

// The location fixture reports the global project id, so the row its foreign keys point at must exist.
const fresh = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* upsertProject(db, { id: Project.ID.global, canonical: AbsolutePath.make("/memory-test") }).pipe(Effect.orDie)
  yield* db.delete(MemoryNodeTable).run().pipe(Effect.orDie)
})

const remember = (input: Parameters<Memory.Interface["remember"]>[0]) =>
  Memory.Service.use((memory) => memory.remember(input))

describe("Memory", () => {
  it.live("facts supersede by subject and predicate and stay idempotent", () =>
    Effect.gen(function* () {
      yield* fresh
      const first = yield* remember({
        kind: "fact",
        title: "",
        triple: { subject: "cache-layer", predicate: "runs_on", object: "redis-alpha" },
        source: "tool",
      })
      const same = yield* remember({
        kind: "fact",
        title: "",
        triple: { subject: "cache-layer", predicate: "runs_on", object: "redis-alpha" },
        source: "tool",
      })
      expect(same.id).toBe(first.id)

      const changed = yield* remember({
        kind: "fact",
        title: "",
        triple: { subject: "cache-layer", predicate: "runs_on", object: "redis-beta" },
        source: "tool",
      })
      expect(changed.id).not.toBe(first.id)

      const page = yield* Memory.Service.use((memory) => memory.list({}))
      expect(page.nodes.filter((node) => node.kind === "fact" && node.status === "current")).toHaveLength(1)

      const overview = yield* Memory.Service.use((memory) => memory.overview())
      expect(overview.nodes.some((node) => node.id === first.id && node.status === "superseded")).toBe(false)
      expect(overview.nodes.some((node) => node.id === changed.id)).toBe(true)

      const search = yield* Memory.Service.use((memory) => memory.search({ query: "cache-layer runs_on redis-beta" }))
      expect(search.matches.some((match) => match.node.id === changed.id)).toBe(true)
    }),
  )

  it.live("a note rewritten under the same title updates in place", () =>
    Effect.gen(function* () {
      yield* fresh
      const before = yield* remember({ kind: "note", title: "freeze-window-policy", text: "draft", source: "tool" })
      const after = yield* remember({
        kind: "note",
        title: "freeze-window-policy",
        text: "final: no deploys on fridays",
        source: "tool",
      })
      expect(after.id).toBe(before.id)
      expect(after.text).toBe("final: no deploys on fridays")
    }),
  )

  it.live("links connect entities and neighbors shows the neighborhood", () =>
    Effect.gen(function* () {
      yield* fresh
      const edge = yield* Memory.Service.use((memory) =>
        memory.link({ from: "billing-worker", relation: "writes_to", to: "ledger-db" }),
      )
      const again = yield* Memory.Service.use((memory) =>
        memory.link({ from: "billing-worker", relation: "writes_to", to: "ledger-db" }),
      )
      expect(again.id).toBe(edge.id)

      const entity = yield* remember({ kind: "entity", title: "billing-worker", source: "tool" })
      const neighborhood = yield* Memory.Service.use((memory) => memory.neighbors(entity.id))
      expect(neighborhood.nodes.some((node) => node.title === "ledger-db")).toBe(true)
      expect(neighborhood.edges.some((link) => link.id === edge.id)).toBe(true)
    }),
  )

  it.live("forget retires a current record once and drops it from recall", () =>
    Effect.gen(function* () {
      yield* fresh
      const note = yield* remember({ kind: "note", title: "decommissioned-homelab-host", text: "retired", source: "tool" })
      const search = yield* Memory.Service.use((memory) => memory.search({ query: "decommissioned-homelab-host" }))
      expect(search.matches.some((match) => match.node.id === note.id)).toBe(true)

      expect(yield* Memory.Service.use((memory) => memory.forget(note.id))).toBe(true)
      expect(yield* Memory.Service.use((memory) => memory.forget(note.id))).toBe(false)
      const after = yield* Memory.Service.use((memory) => memory.search({ query: "decommissioned-homelab-host" }))
      expect(after.matches.some((match) => match.node.id === note.id)).toBe(false)

      const page = yield* Memory.Service.use((memory) => memory.list({}))
      expect(page.nodes.some((node) => node.id === note.id && node.status === "superseded")).toBe(true)
    }),
  )

  it.live("writes strip invisible characters and redact credential shapes", () =>
    Effect.gen(function* () {
      yield* fresh
      const note = yield* remember({
        kind: "note",
        title: "side\u200bcar deploy key location​",
        text: "stored as sk-abcdefghijklmnopqrstuvwxyz1234 on the build box",
        source: "tool",
      })
      expect(note.title).toBe("sidecar deploy key location")
      expect(note.text).toContain("[redacted]")
      expect(note.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234")
    }),
  )

  it.live("the overview card stays bounded and names the top records", () =>
    Effect.gen(function* () {
      yield* fresh
      yield* remember({ kind: "note", title: "gateway-runs-behind-traefik", text: "tls terminates at traefik", importance: 0.9, source: "tool" })
      yield* remember({ kind: "note", title: "migrations-before-deploy", text: "apply migrations first", importance: 0.8, source: "tool" })
      const overview = yield* Memory.Service.use((memory) => memory.overview())
      expect(overview.card).toContain("PROJECT MEMORY")
      expect(overview.card).toContain("gateway-runs-behind-traefik")
      expect(overview.card.length).toBeLessThan(2_000)
      expect(overview.counts.notes).toBeGreaterThanOrEqual(2)
    }),
  )
})
