import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql.js"

/**
 * Project-scoped durable todos. The legacy `todo` table is the removed v1
 * session-planning store; this one is the cross-session knowledge surface
 * (voice notes, agents, and the user all write here).
 */
export const ProjectTodoTable = sqliteTable(
  "project_todo",
  {
    id: text().primaryKey(),
    directory: text().notNull(),
    text: text().notNull(),
    description: text(),
    refs: text({ mode: "json" }).$type<readonly { label: string; uri: string }[]>(),
    status: text().$type<"open" | "done">().notNull(),
    done_at: integer(),
    source: text().$type<"voice" | "agent" | "user">().notNull(),
    ...Timestamps,
  },
  (table) => [index("project_todo_directory_idx").on(table.directory), index("project_todo_status_idx").on(table.status)],
)
