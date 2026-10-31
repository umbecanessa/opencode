import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261031064708_execution_attribution",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`execution_owner\` text;`)
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`execution_url\` text;`)
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`execution_fence\` integer DEFAULT 0 NOT NULL;`)
    })
  },
}

export default migration
