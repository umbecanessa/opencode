export * as ConfigWorkspace from "./workspace.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  type: Schema.Literal("ssh").annotate({
    description: "Placement driver. Only ssh is supported: commands and file operations run on the host over ssh",
  }),
  host: Schema.String.annotate({
    description: "Host to connect to, resolved by the local ssh binary (ssh config aliases work)",
  }),
  port: Schema.Number.pipe(optional).annotate({
    description: "SSH port (default: the ssh binary's own resolution)",
  }),
  user: Schema.String.pipe(optional).annotate({
    description: "SSH user (default: the local ssh default user)",
  }),
  identity: Schema.String.pipe(optional).annotate({
    description: "Path to a private key file, passed to the local ssh binary with -i",
  }),
  directory: Schema.String.annotate({
    description: "Absolute project directory ON THE REMOTE HOST that placed sessions run in",
  }),
}).annotate({ identifier: "Config.Workspace" })
