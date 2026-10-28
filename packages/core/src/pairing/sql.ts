import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql.js"

// Single-use pairing-link codes. Persisted (not process memory) so redemption reaches the code no matter which
// server process answers — e.g. Tailscale serve proxying to a different instance, or an app restart after minting.
export const PairingCodeTable = sqliteTable("pairing_code", {
  code: text().primaryKey(),
  ...Timestamps,
})
