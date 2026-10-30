export * as ConfigServer from "./server.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  url: Schema.String.annotate({
    description: "Base URL of the other OpenCode server, for example http://192.168.1.20:4096",
  }),
  credential: Schema.String.pipe(optional).annotate({
    description: "Server password, sent as the Basic auth password with username opencode",
  }),
}).annotate({ identifier: "Config.Server" })
