import { blob, index, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql.js"
import { ProjectTable } from "../project/sql.js"
import type { Memory } from "@opencode/schema/memory"
import type { Project } from "@opencode/schema/project"

// The project knowledge graph. Rows are scoped by project_id; the FTS5 index over
// title/text/triple fields is a virtual table created lazily by the Memory service
// (drizzle cannot express FTS5), kept in sync by triggers it installs alongside.
export const MemoryNodeTable = sqliteTable(
  "memory_node",
  {
    id: text().primaryKey(),
    project_id: text()
      .$type<Project.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    kind: text().$type<Memory.Kind>().notNull(),
    title: text().notNull(),
    text: text(),
    subject: text(),
    predicate: text(),
    object: text(),
    status: text()
      .$type<Memory.Status>()
      .notNull()
      .default("current"),
    confidence: real().notNull().default(0.75),
    importance: real().notNull().default(0.5),
    source: text().$type<Memory.Source>().notNull(),
    session_id: text(),
    /** float32 little-endian vector, when an embeddings endpoint was configured at write time. */
    embedding: blob({ mode: "buffer" }),
    ...Timestamps,
  },
  (table) => [
    index("memory_node_project_status_idx").on(table.project_id, table.status),
    index("memory_node_fact_idx").on(table.project_id, table.subject, table.predicate, table.status),
    index("memory_node_project_time_idx").on(table.project_id, table.time_updated),
  ],
)

export const MemoryEdgeTable = sqliteTable(
  "memory_edge",
  {
    id: text().primaryKey(),
    project_id: text()
      .$type<Project.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    source: text()
      .notNull()
      .references(() => MemoryNodeTable.id, { onDelete: "cascade" }),
    relation: text().notNull(),
    target: text()
      .notNull()
      .references(() => MemoryNodeTable.id, { onDelete: "cascade" }),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("memory_edge_unique_idx").on(table.project_id, table.source, table.relation, table.target),
    index("memory_edge_target_idx").on(table.project_id, table.target),
  ],
)
