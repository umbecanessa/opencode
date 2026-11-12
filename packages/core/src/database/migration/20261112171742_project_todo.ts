import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261112171742_project_todo",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`project_todo\` (
          \`id\` text PRIMARY KEY,
          \`directory\` text NOT NULL,
          \`text\` text NOT NULL,
          \`description\` text,
          \`refs\` text,
          \`status\` text NOT NULL,
          \`done_at\` integer,
          \`source\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`project_todo_directory_idx\` ON \`project_todo\` (\`directory\`);`)
      yield* tx.run(`CREATE INDEX \`project_todo_status_idx\` ON \`project_todo\` (\`status\`);`)
    })
  },
}

export default migration
