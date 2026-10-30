import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { ChildProcess } from "effect/process"
import { make } from "effect/process/ChildProcessSpawner"
import { systemError } from "effect/PlatformError"
import { Workspace } from "@opencode/core/workspace"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import { makeSshDriver, translate } from "@opencode/core/workspace/driver-ssh"
import { it } from "./lib/effect"

const captureMarker = systemError({ _tag: "Unknown", module: "test", method: "spawn", description: "not really spawning" })
const captureSpawner = (commands: ChildProcess.Command[]) =>
  make((command) => Effect.sync(() => commands.push(command)).pipe(Effect.andThen(Effect.fail(captureMarker))))

describe("ssh workspace driver", () => {
  it.effect("translates a command into ssh argv with quoting and env filtering", () =>
    Effect.sync(() => {
      const invocation = translate(
        { host: "example.invalid", user: "bob", port: 2225, identity: "/keys/id" },
        {
          command: "sh",
          args: ["-c", "echo it's && ls"],
          cwd: "/srv/app",
          env: { LC_ALL: "C", PATH: "/local/bin", LANG: "en_US.UTF-8" },
        },
      )
      expect(invocation.command).toBe("ssh")
      expect(invocation.args).toContain("BatchMode=yes")
      expect(invocation.args.slice(invocation.args.indexOf("-p") + 1, invocation.args.indexOf("-p") + 3)).toEqual([
        "2225",
        "-i",
      ])
      expect(invocation.args[invocation.args.indexOf("-i") + 1]).toBe("/keys/id")
      expect(invocation.args.slice(-2)).toEqual([
        "bob@example.invalid",
        "cd '/srv/app' && export LC_ALL='C' && export LANG='en_US.UTF-8' && 'sh' '-c' 'echo it'\\''s && ls'",
      ])
    }),
  )

  it.effect("translates a bare target without cd or exports", () =>
    Effect.sync(() => {
      const invocation = translate({ host: "box.example" }, { command: "ls", args: ["-l"] })
      expect(invocation.args[invocation.args.length - 2]).toBe("box.example")
      expect(invocation.args[invocation.args.length - 1]).toBe("'ls' '-l'")
    }),
  )

  it.effect("fails create honestly: ssh hosts are configured, not provisioned", () =>
    Effect.gen(function* () {
      const driver = makeSshDriver(captureSpawner([]))
      const error = yield* driver.create({ workspaceID: Workspace.ID.create() }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(WorkspaceDriver.Error)
      expect(String(error)).toContain("configured through the config `workspaces` map")
    }),
  )

  it.effect("fails connect on a malformed binding", () =>
    Effect.gen(function* () {
      const driver = makeSshDriver(captureSpawner([]))
      const error = yield* driver
        .connect({ workspaceID: Workspace.ID.ascending("wrk_test"), binding: { host: 1 }, saveBinding: () => Effect.void })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(WorkspaceDriver.Error)
    }),
  )

  it.effect("routes spawns through ssh with the remote cd prefix", () =>
    Effect.gen(function* () {
      const commands: ChildProcess.Command[] = []
      const driver = makeSshDriver(captureSpawner(commands))
      const environment = yield* driver.connect({
        workspaceID: Workspace.ID.ascending("wrk_test"),
        binding: { host: "example.invalid", user: "bob" },
        saveBinding: () => Effect.void,
      })
      yield* environment.spawner
        .spawn(ChildProcess.make("sh", ["-c", "echo hi"], { cwd: "/srv/app", env: { LC_ALL: "C", PATH: "/poison" } }))
        .pipe(Effect.flip)
      expect(commands).toHaveLength(1)
      const command = commands[0]
      if (command?._tag !== "StandardCommand") return yield* Effect.die("expected a standard command")
      expect(command.command).toBe("ssh")
      expect(command.args.slice(-2)).toEqual([
        "bob@example.invalid",
        "cd '/srv/app' && export LC_ALL='C' && 'sh' '-c' 'echo hi'",
      ])
      // Local cwd and shell wrapping must not survive into the ssh spawn.
      expect(command.options.cwd).toBeUndefined()
      expect(command.options.shell).toBeUndefined()
    }),
  )

  it.effect("idle suspension and destroy are no-ops", () =>
    Effect.gen(function* () {
      const driver = makeSshDriver(captureSpawner([]))
      yield* driver.suspendForIdle({
        workspaceID: Workspace.ID.create(),
        binding: {},
        saveBinding: () => Effect.void,
      })
      yield* driver.destroy({ workspaceID: Workspace.ID.create(), binding: null })
    }),
  )
})
