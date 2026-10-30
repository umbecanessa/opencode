export * as WorkspaceDriverSsh from "./driver-ssh.js"

import os from "node:os"
import path from "node:path"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner, make } from "effect/process/ChildProcessSpawner"
import { systemError } from "effect/PlatformError"
import { WorkspaceDriver } from "./driver.js"

/** Connection data for one ssh host. Read from the workspace binding; the config entry is the writer. */
export interface Target {
  readonly host: string
  readonly port?: number
  readonly user?: string
  readonly identity?: string
}

const Binding = Schema.Struct({
  host: Schema.String,
  port: Schema.optionalKey(Schema.Number),
  user: Schema.optionalKey(Schema.String),
  identity: Schema.optionalKey(Schema.String),
})

// POSIX quoting for the single string ssh hands to the remote shell.
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

// The remote login environment is authoritative: forwarding the local PATH or HOME
// would poison the remote host. Locale and terminal hints are the exception because
// exec-defaults scripts pin LC_ALL=C and shell behavior legitimately follows TERM.
const forwardEnv = (key: string) => key === "TERM" || key === "LANG" || key === "TZ" || key.startsWith("LC_")

// Win32-OpenSSH rejects ControlPath, so multiplexing is Unix-local-client only.
const multiplex = process.platform !== "win32"
const controlPath = path.join(os.tmpdir(), "opencode-ssh-%C.sock")

/** Pure ssh argv translation, exported for table tests. */
export const translate = (
  target: Target,
  input: { readonly command: string; readonly args: readonly string[]; readonly cwd?: string; readonly env?: Record<string, string | undefined> },
) => {
  const args = multiplex
    ? ["-o", "BatchMode=yes", "-o", "ControlMaster=auto", "-o", `ControlPath=${controlPath}`, "-o", "ControlPersist=60"]
    : ["-o", "BatchMode=yes"]
  if (target.port !== undefined) args.push("-p", String(target.port))
  if (target.identity !== undefined) args.push("-i", target.identity)
  const exports = Object.entries(input.env ?? {})
    .filter(([key, value]) => value !== undefined && forwardEnv(key))
    .map(([key, value]) => `export ${key}=${quote(value as string)} && `)
  const remote =
    (input.cwd === undefined ? "" : `cd ${quote(input.cwd)} && `) +
    exports.join("") +
    [quote(input.command), ...input.args.map(quote)].join(" ")
  return { command: "ssh", args: [...args, target.user === undefined ? target.host : `${target.user}@${target.host}`, remote] }
}

const sshSpawner = (local: ChildProcessSpawner["Service"], target: Target) =>
  make((command) =>
    Effect.suspend(() => {
      if (command._tag !== "StandardCommand")
        return Effect.fail(
          systemError({
            _tag: "Unknown",
            module: "WorkspaceDriverSsh",
            method: "spawn",
            description: "ssh workspaces do not support piped commands",
          }),
        )
      const invocation = translate(target, {
        command: command.command,
        args: command.args,
        ...(command.options.cwd === undefined ? {} : { cwd: command.options.cwd }),
        ...(command.options.env === undefined ? {} : { env: command.options.env }),
      })
      // cwd and the forwarded env moved into the remote string; a local shell wrapper
      // would re-quote the remote string, so both are stripped from the ssh spawn.
      return local.spawn(
        ChildProcess.make(invocation.command, invocation.args, { ...command.options, cwd: undefined, shell: undefined }),
      )
    }),
  )

export const makeSshDriver = (local: ChildProcessSpawner["Service"]): WorkspaceDriver.Interface => ({
  // ssh hosts are pre-existing machines, not resources this process may provision.
  create: () =>
    Effect.fail(
      new WorkspaceDriver.Error({
        message: "ssh workspaces are configured through the config `workspaces` map, not created at runtime",
      }),
    ),
  connect: ({ binding }) =>
    Schema.decodeUnknownEffect(Binding)(binding).pipe(
      Effect.mapError(() => new WorkspaceDriver.Error({ message: `invalid ssh workspace binding: ${JSON.stringify(binding)}` })),
      Effect.map((target) => ({ spawner: sshSpawner(local, target) })),
    ),
  suspendForIdle: () => Effect.void,
  destroy: () => Effect.void,
})

export const node = makeGlobalNode({
  service: WorkspaceDriver.RegistryService,
  layer: Layer.effect(
    WorkspaceDriver.RegistryService,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner
      return WorkspaceDriver.RegistryService.of(WorkspaceDriver.registry({ ssh: makeSshDriver(spawner) }))
    }),
  ),
  deps: [CrossSpawnSpawner.node],
})
