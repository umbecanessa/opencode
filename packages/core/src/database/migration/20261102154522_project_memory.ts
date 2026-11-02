import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261102154522_project_memory",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory_edge\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`source\` text NOT NULL,
          \`relation\` text NOT NULL,
          \`target\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_memory_edge_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_memory_edge_source_memory_node_id_fk\` FOREIGN KEY (\`source\`) REFERENCES \`memory_node\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_memory_edge_target_memory_node_id_fk\` FOREIGN KEY (\`target\`) REFERENCES \`memory_node\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_node\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`title\` text NOT NULL,
          \`text\` text,
          \`subject\` text,
          \`predicate\` text,
          \`object\` text,
          \`status\` text DEFAULT 'current' NOT NULL,
          \`confidence\` real DEFAULT 0.75 NOT NULL,
          \`importance\` real DEFAULT 0.5 NOT NULL,
          \`source\` text NOT NULL,
          \`session_id\` text,
          \`embedding\` blob,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_memory_node_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`memory_edge_unique_idx\` ON \`memory_edge\` (\`project_id\`,\`source\`,\`relation\`,\`target\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_edge_target_idx\` ON \`memory_edge\` (\`project_id\`,\`target\`);`)
      yield* tx.run(`CREATE INDEX \`memory_node_project_status_idx\` ON \`memory_node\` (\`project_id\`,\`status\`);`)
      yield* tx.run(
        `CREATE INDEX \`memory_node_fact_idx\` ON \`memory_node\` (\`project_id\`,\`subject\`,\`predicate\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`memory_node_project_time_idx\` ON \`memory_node\` (\`project_id\`,\`time_updated\`);`,
      )
    })
  },
}

export default migration
