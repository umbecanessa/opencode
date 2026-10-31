export * as SessionTools from "./session.js"

import { SystemPart, ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { Tool } from "@opencode/schema/tool"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { DateTime, Effect, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { FileAccess } from "../../file-access.js"
import { Job } from "../../job.js"
import { Model } from "../../model.js"
import { PeerPlacements } from "../../peer-placements.js"
import { PeerServers } from "../../peer-servers.js"
import { Permission } from "../../permission.js"
import { AbsolutePath } from "../../schema.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { SubagentCompletion } from "../../session/subagent-completion.js"
import { SubagentJob } from "../../session/subagent-job.js"
import { Workspace } from "../../workspace.js"

const spawnResult = (sessionID: SessionSchema.ID) => ({
  sessionID,
  status: "running" as const,
  output: [
    `The peer session is working (sessionID: ${sessionID}). You will be notified automatically when it finishes.`,
    "DO NOT sleep, poll for progress, ask the peer for status, or duplicate this peer session's work.",
    "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
  ].join("\n"),
})

const parseModel = (requested: string) =>
  Effect.try({
    try: () => Model.Ref.parse(requested),
    catch: () => new ToolFailure({ message: `Invalid model "${requested}". Use "providerID/modelID#variant".` }),
  })

// Remote dispatch gates on its own `server` permission action: talking to another machine
// is a bigger step than coordinating sessions on this one.
const assertServer = (permission: Permission.Interface, server: string, context: Tool.Context) =>
  permission
    .assert({
      action: "server",
      resources: [server],
      save: [server],
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
    })
    .pipe(Effect.mapError((error) => new ToolFailure({ message: `Cross-server dispatch denied: ${server}`, error })))

// Placing a session's execution on another machine gates on its own `workspace`
// permission action, mirroring the `server` action for cross-server dispatch.
const assertWorkspace = (permission: Permission.Interface, workspace: string, context: Tool.Context) =>
  permission
    .assert({
      action: "workspace",
      resources: [workspace],
      save: [workspace],
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
    })
    .pipe(Effect.mapError((error) => new ToolFailure({ message: `Remote placement denied: ${workspace}`, error })))

const serverField = Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))).annotate({
  description:
    "Name of a peer OpenCode server to act against instead of this one: a key of the config `servers` map or a server registered at runtime by a connected client.",
})

const SpawnInput = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Short title for the new session, summarizing the work it will do",
  }),
  prompt: Schema.String.annotate({
    description: "The full instructions for the spawned session. It starts with no context.",
  }),
  agent: Schema.optionalKey(Schema.String).annotate({
    description:
      "Agent for the spawned session (default: your own agent). Unlike subagents, any agent may run, including primary agents.",
  }),
  model: Schema.optionalKey(Schema.String).annotate({
    description: 'Model as "providerID/modelID" or "providerID/modelID#variant". Look it up with the models tool; do not guess.',
  }),
  directory: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))).annotate({
    description:
      "Absolute path of another project directory to run the session in (default: your current location).",
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Return immediately instead of blocking until the session finishes. You will be notified when it completes. DO NOT sleep or poll.",
  }),
  temporary: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "true creates a disposable session: it never appears in session lists and is deleted roughly a day after finishing. Prefer true for spot tasks the user should not see in history. The session's permissions default to no edits, no subagents, and no peer spawning.",
  }),
  server: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))).annotate({
    description:
      'Name of a configured peer OpenCode server (config "servers") to dispatch to. The session runs there and its final text is returned; background=true works there too (completion arrives as a <peer> message) and the placement routes later send, stop, and wait calls by session ID; directory does not apply.',
  }),
  workspace: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))).annotate({
    description:
      'Name of a configured ssh workspace (config "workspaces") to place the session on: its shell and file tools operate on the remote host inside the entry\'s directory. server and directory do not apply.',
  }),
})

const SpawnOutput = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literals(["completed", "running"]),
  output: Schema.String,
})

const SendInput = Schema.Struct({
  sessionID: SessionSchema.ID,
  prompt: Schema.String.annotate({ description: "The follow-up instructions for the session" }),
  delivery: Schema.optionalKey(SessionInbox.Delivery).annotate({
    description: "steer interrupts at the next safe boundary (default); queue parks it until the session would go idle",
  }),
  resume: Schema.optionalKey(Schema.Boolean).annotate({
    description: "false admits the prompt without waking an idle session. Default true.",
  }),
  server: serverField,
})

const StopInput = Schema.Struct({
  sessionID: SessionSchema.ID,
  resume: Schema.optionalKey(Schema.Boolean).annotate({
    description: "true keeps pending steering and queued controls pending after the interrupt. Default false.",
  }),
  server: serverField,
})

const WaitInput = Schema.Struct({
  sessionID: SessionSchema.ID,
  timeout: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 }))).annotate({
    description: "Maximum seconds to wait for the session to go idle. Defaults to 60.",
  }),
  server: serverField,
})

const ListInput = Schema.Struct({
  search: Schema.optionalKey(Schema.String).annotate({ description: "Filter by title match" }),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))).annotate({
    description: "Maximum sessions to return. Defaults to 20, newest first.",
  }),
  temporary: Schema.optionalKey(Schema.Boolean).annotate({
    description: "true lists only the disposable temporary sessions (they are otherwise invisible).",
  }),
  server: serverField,
})

const ListOutput = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: SessionSchema.ID,
      title: Schema.optionalKey(Schema.String),
      agent: Schema.optionalKey(Schema.String),
      model: Schema.optionalKey(Schema.String).annotate({
        description: "providerID/modelID[#variant] currently selected",
      }),
      directory: Schema.String.annotate({ description: "Absolute directory the session runs in" }),
      active: Schema.Boolean.annotate({ description: "Whether a run is currently executing here" }),
      outcome: Schema.optionalKey(Schema.Literals(["succeeded", "failed", "interrupted"])),
      updated: Schema.Number.annotate({ description: "Unix milliseconds of the last update" }),
      parentID: Schema.optionalKey(SessionSchema.ID).annotate({
        description: "Present when the session is a subagent child",
      }),
    }),
  ),
})

export const Plugin = {
  id: "opencode.tool.session",
  effect: Effect.fn("SessionTools.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const access = yield* FileAccess.Service
    const jobs = yield* Job.Service
    const permission = yield* Permission.Service
    const models = yield* Model.Service
    const subagents = yield* SubagentJob.Service
    const peers = yield* PeerServers.Service
    const placements = yield* PeerPlacements.Service
    const config = yield* Config.Service
    const workspaces = yield* Workspace.Service

    // Placement on a configured ssh workspace: the session row stays in this
    // server's database; only the location gains a workspace whose driver
    // relocates shell and file execution to the remote host. Children inherit
    // the location, so subagents and peers of a placed session run remotely too.
    const placeOnWorkspace = (name: string, context: Tool.Context) =>
      Effect.gen(function* () {
        const entries = Config.latest(yield* config.entries(), "workspaces")
        const entry = entries?.[name]
        if (entry === undefined)
          return yield* new ToolFailure({
            message: `Workspace "${name}" is not configured. Configured workspaces: ${Object.keys(entries ?? {}).join(", ") || "none"}`,
          })
        yield* assertWorkspace(permission, name, context)
        const workspaceID = Workspace.ID.ascending(`wrk_cfg_${name}`)
        yield* workspaces
          .create({ id: workspaceID, provider: entry.type })
          .pipe(Effect.mapError((error) => new ToolFailure({ message: `Unable to register workspace "${name}"`, error })))
        yield* workspaces
          .setBinding(workspaceID, {
            host: entry.host,
            ...(entry.port === undefined ? {} : { port: entry.port }),
            ...(entry.user === undefined ? {} : { user: entry.user }),
            ...(entry.identity === undefined ? {} : { identity: entry.identity }),
          })
          .pipe(Effect.mapError((error) => new ToolFailure({ message: `Unable to pin workspace "${name}"`, error })))
        return { directory: AbsolutePath.make(entry.directory), workspaceID }
      })

    // Target routing for session_send/stop/wait: an explicit server parameter
    // wins; otherwise the session is local, or a placement recorded by an
    // earlier dispatch routes it by session ID alone.
    const resolveServer = (sessionID: SessionSchema.ID, server: string | undefined) =>
      server !== undefined
        ? Effect.succeed<string | undefined>(server)
        : sessions.get(sessionID).pipe(
            Effect.as(undefined),
            Effect.catch(() =>
              placements.locate(sessionID).pipe(
                Effect.map((entry) => (entry._tag === "Some" ? entry.value.server : undefined)),
              ),
            ),
          )

    // A 404 from the peer disproves the placement record: drop it so a later
    // call reports the session as simply not found.
    const forgetIfGone = <A>(
      server: string,
      sessionID: SessionSchema.ID,
      effect: Effect.Effect<A, PeerServers.Failure>,
    ) =>
      effect.pipe(
        Effect.catch((failure) =>
          failure.notFound === true
            ? placements.forget(sessionID).pipe(Effect.flatMap(() => Effect.fail(failure)))
            : Effect.fail(failure),
        ),
      )

    const remoteFailure = (server: string) => (error: PeerServers.Failure) =>
      new ToolFailure({ message: `Unable to reach ${server}: ${error.detail}`, error })

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: "session_list",
          description: [
            "List recent sessions on this OpenCode server with their activity, or on a named peer server with the server parameter.",
            "Use it to find a session the user refers to without an ID.",
          ].join(" "),
          input: ListInput,
          output: ListOutput,
          options: { namespace: "opencode", codemode: false, permission: "session" },
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.server !== undefined) {
                yield* assertServer(permission, input.server, context)
                const data = yield* peers
                  .list(input.server, {
                    ...(input.limit === undefined ? {} : { limit: input.limit }),
                    ...(input.search === undefined ? {} : { search: input.search }),
                    ...(input.temporary === undefined ? {} : { temporary: input.temporary }),
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Unable to list sessions on ${input.server}`, error }),
                    ),
                  )
                return { output: { data } }
              }
              yield* permission
                .assert({
                  action: "session",
                  resources: ["*"],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: "Session coordination denied", error })))
              const page = yield* sessions.list({
                order: "desc",
                limit: input.limit ?? 20,
                ...(input.search === undefined ? {} : { search: input.search }),
                ...(input.temporary === undefined ? {} : { temporary: input.temporary }),
              })
              const active = yield* sessions.active
              return {
                output: {
                  data: page.data.map((session) => ({
                    id: session.id,
                    ...(session.title === undefined ? {} : { title: session.title }),
                    ...(session.agent === undefined ? {} : { agent: session.agent }),
                    ...(session.model === undefined
                      ? {}
                      : {
                          model: `${session.model.providerID}/${session.model.id}${
                            session.model.variant ? `#${session.model.variant}` : ""
                          }`,
                        }),
                    directory: session.location.directory,
                    active: active.has(session.id),
                    ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
                    updated: DateTime.toEpochMillis(session.time.updated),
                    ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
                  })),
                },
              }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: "Unable to list sessions", error }))),
        })

        editor.add({
          name: "session_spawn",
          description: [
            "Creates a new top-level session (a peer main agent, not a subagent) and runs the given prompt in it.",
            "Prefer the subagent tool for delegated work inside your own project; use session_spawn for standalone main-agent work or work that belongs to another project directory.",
            "The spawned session starts with no context and is not linked as your child: include everything it needs in the prompt.",
            "Foreground (default) blocks until the session goes idle and returns its final text.",
            "With background=true it returns immediately and a <peer> completion message is added to this conversation when it finishes; DO NOT sleep or poll before that message arrives.",
            "Set temporary=true for disposable spot tasks that should stay out of the user's session history.",
            "Set server to dispatch the whole task to a named peer OpenCode server (config `servers` or registered by the desktop): it runs there and returns its final text. background=true is supported there too: the dispatch returns immediately and its completion arrives as a <peer> message.",
            "The server parameter is optional for session_send, session_stop, and session_wait on sessions you dispatched: their placement routes the call by session ID alone.",
            "Set workspace to a named ssh workspace from the config `workspaces` map: the session's shell and file tools operate on that remote host inside the entry's directory (directory does not apply).",
          ].join("\n"),
          input: SpawnInput,
          output: SpawnOutput,
          options: { namespace: "opencode", codemode: false, permission: "session" },
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.server !== undefined) {
                if (input.directory !== undefined)
                  return yield* new ToolFailure({
                    message: "directory does not apply with server: the session runs in the peer server's own project location.",
                  })
                if (input.workspace !== undefined)
                  return yield* new ToolFailure({
                    message: "workspace does not apply with server: the peer server places the session itself.",
                  })
                yield* assertServer(permission, input.server, context)
                const remoteModel = input.model === undefined ? undefined : yield* parseModel(input.model)
                const remoteInput = {
                  title: input.title,
                  prompt: input.prompt,
                  ...(input.agent === undefined ? {} : { agent: input.agent }),
                  ...(remoteModel === undefined ? {} : { model: remoteModel }),
                  ...(input.temporary === undefined ? {} : { temporary: input.temporary }),
                }
                if (input.background === true) {
                  const dispatched = yield* peers
                    .dispatch(input.server, remoteInput)
                    .pipe(Effect.mapError((error) => new ToolFailure({ message: `Unable to dispatch to ${input.server}`, error })))
                  yield* placements
                    .record(input.server, dispatched.sessionID)
                    .pipe(
                      Effect.mapError(
                        (error) => new ToolFailure({ message: `Unable to place the dispatched session: ${error.message}` }),
                      ),
                    )
                  const recovery = {
                    kind: "peer_remote" as const,
                    parentSessionID: context.sessionID,
                    childSessionID: dispatched.sessionID,
                    server: input.server,
                    agent: input.agent ?? Agent.defaultID,
                    description: input.title,
                  }
                  // The local job is only the completion observer: its run waits on
                  // the peer and survives restarts through restart recovery.
                  yield* jobs.start({
                    id: dispatched.sessionID,
                    type: "subagent",
                    title: input.title,
                    recovery,
                    run: peers.watch(input.server, dispatched.sessionID),
                  })
                  yield* context.progress({ sessionID: dispatched.sessionID, status: "running" })
                  yield* subagents.background(recovery)
                  return spawnResult(dispatched.sessionID)
                }
                const result = yield* peers
                  .spawn(input.server, remoteInput)
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Unable to dispatch to ${input.server}`, error }),
                    ),
                  )
                // Record even for the foreground dispatch: later sends, stops, and
                // waits route by this session ID alone.
                yield* placements
                  .record(input.server, result.sessionID)
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Unable to place the dispatched session: ${error.message}` }),
                    ),
                  )
                if (result.outcome === "failed")
                  return yield* new ToolFailure({
                    message: `Peer session failed (sessionID: ${result.sessionID} on ${input.server})`,
                  })
                if (result.outcome === "interrupted")
                  return yield* new ToolFailure({
                    message: `Peer session was interrupted (sessionID: ${result.sessionID} on ${input.server})`,
                  })
                return {
                  sessionID: result.sessionID,
                  status: "completed" as const,
                  output: result.text ?? SubagentCompletion.NO_TEXT,
                }
              }
              const parent = yield* sessions
                .get(context.sessionID)
                .pipe(Effect.mapError(() => new ToolFailure({ message: "Parent session not found" })))
              if (input.workspace !== undefined && input.directory !== undefined)
                return yield* new ToolFailure({
                  message: "directory does not apply with workspace: the config entry's directory is the remote project root.",
                })
              const agent =
                input.agent === undefined
                  ? yield* (parent.agent === undefined ? Effect.succeed(undefined) : agents.resolve(parent.agent))
                  : yield* agents.resolve(input.agent)
              if (input.agent !== undefined && agent === undefined)
                return yield* new ToolFailure({ message: `Unknown agent: ${input.agent}` })
              const agentID = agent?.id ?? parent.agent ?? Agent.defaultID
              yield* permission
                .assert({
                  action: "session",
                  resources: [agentID],
                  save: [agentID],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
                .pipe(
                  Effect.mapError((error) => new ToolFailure({ message: `Session coordination denied: ${agentID}`, error })),
                )

              const override = input.model === undefined ? undefined : yield* parseModel(input.model)
              if (override !== undefined && !(yield* models.available()).some((model) => model.providerID === override.providerID && model.id === override.id))
                return yield* new ToolFailure({
                  message: `Model "${override.providerID}/${override.id}" is not available. Use the models tool to see what is available.`,
                })

              const location =
                input.workspace !== undefined
                  ? yield* placeOnWorkspace(input.workspace, context)
                  : input.directory === undefined
                    ? parent.location
                    : {
                        directory: (yield* access
                          .resolve({ path: input.directory, kind: "directory" })
                          .pipe(
                            Effect.mapError(
                              () => new ToolFailure({ message: `Unable to resolve directory: ${input.directory}` }),
                            ),
                          )).absolute,
                      }
              const model = override ?? agent?.model ?? parent.model
              const child = yield* sessions
                .create({
                  location,
                  title: input.title,
                  agent: agentID,
                  model,
                  ...(input.temporary === undefined ? {} : { temporary: input.temporary }),
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to create the session" })))

              const background = input.background === true
              yield* context.progress({ sessionID: child.id, status: "running" })

              // Admit without waking so the owned job run drives the first execution,
              // mirroring how background subagent children are observed and recovered.
              yield* sessions
                .prompt({
                  sessionID: child.id,
                  text: input.prompt,
                  ...(background ? { resume: false } : {}),
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: `Failed to prompt session: ${child.id}` })))

              const recovery = {
                kind: "peer" as const,
                parentSessionID: context.sessionID,
                childSessionID: child.id,
                agent: agentID,
                description: input.title,
              }
              yield* subagents.start(recovery)

              if (background) {
                yield* subagents.background(recovery)
                return spawnResult(child.id)
              }

              const result = yield* jobs.block({ id: child.id, sessionID: context.sessionID }).pipe(
                Effect.onInterrupt(() =>
                  Effect.all([sessions.interrupt(child.id), jobs.cancel(child.id)], { discard: true }),
                ),
              )
              if (result?.type === "backgrounded") {
                yield* subagents.notify(recovery, result.info.started_at)
                return spawnResult(child.id)
              }
              if (result?.info.status === "error")
                return yield* new ToolFailure({
                  message: `Peer session failed (sessionID: ${child.id}): ${result.info.error ?? "unknown error"}`,
                })
              if (result?.info.status === "cancelled")
                return yield* new ToolFailure({ message: `Peer session cancelled (sessionID: ${child.id})` })
              return {
                sessionID: child.id,
                status: "completed" as const,
                output: result?.info.output ?? SubagentCompletion.NO_TEXT,
              }
            }).pipe(
              Effect.map((output) => ({
                output,
                content:
                  output.status === "completed"
                    ? `<peer sessionID="${output.sessionID}" state="completed">\n${output.output}\n</peer>`
                    : output.output,
                metadata: { sessionID: output.sessionID, status: output.status },
              })),
            ),
        })

        editor.add({
          name: "session_send",
          description: [
            "Sends a follow-up prompt to an existing session by ID, reusing everything it already knows.",
            "The session keeps its current agent and model.",
            "A completion notification is NOT sent for this message; use session_wait to join the run, or session_spawn with background for notified runs.",
            "A session you dispatched to a peer server earlier is routed by its ID alone; pass server explicitly only for sessions you did not dispatch.",
            "If the session is not found it may be an expired temporary session; spawn a fresh one with the needed context instead.",
          ].join("\n"),
          input: SendInput,
          output: Schema.Struct({ sessionID: SessionSchema.ID, accepted: Schema.Boolean }),
          options: { namespace: "opencode", codemode: false, permission: "session" },
          execute: (input, context) =>
            Effect.gen(function* () {
              const server = yield* resolveServer(input.sessionID, input.server)
              if (server !== undefined) {
                yield* assertServer(permission, server, context)
                yield* forgetIfGone(
                  server,
                  input.sessionID,
                  peers.send(server, {
                    sessionID: input.sessionID,
                    prompt: input.prompt,
                    ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
                  }),
                ).pipe(Effect.mapError(remoteFailure(server)))
                return {
                  output: { sessionID: input.sessionID, accepted: true },
                  content: `Prompt delivered to ${input.sessionID} on ${server}.`,
                }
              }
              yield* sessions
                .get(input.sessionID)
                .pipe(Effect.mapError(() => new ToolFailure({ message: `Session not found: ${input.sessionID}` })))
              yield* permission
                .assert({
                  action: "session",
                  resources: [input.sessionID],
                  save: [input.sessionID],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
                .pipe(
                  Effect.mapError((error) =>
                    new ToolFailure({ message: `Session coordination denied: ${input.sessionID}`, error }),
                  ),
                )
              yield* sessions
                .prompt({
                  sessionID: input.sessionID,
                  text: input.prompt,
                  ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
                  ...(input.resume === undefined ? {} : { resume: input.resume }),
                })
                .pipe(
                  Effect.mapError(() => new ToolFailure({ message: `Failed to prompt session: ${input.sessionID}` })),
                )
              return {
                output: { sessionID: input.sessionID, accepted: true },
                content: `Prompt delivered to ${input.sessionID}.`,
              }
            }),
        })

        editor.add({
          name: "session_stop",
          description: [
            "Interrupts a session's active execution. Queued prompts remain parked; the session's history stays intact and session_send can continue it.",
            "Returns interrupted=true only when a run was actually stopped; false means the session was idle.",
            "A session you dispatched to a peer server earlier is stopped by its ID alone.",
          ].join("\n"),
          input: StopInput,
          output: Schema.Struct({ sessionID: SessionSchema.ID, interrupted: Schema.Boolean }),
          options: { namespace: "opencode", codemode: false, permission: "session" },
          execute: (input, context) =>
            Effect.gen(function* () {
              const server = yield* resolveServer(input.sessionID, input.server)
              if (server !== undefined) {
                yield* assertServer(permission, server, context)
                const interrupted = yield* forgetIfGone(
                  server,
                  input.sessionID,
                  peers.stop(server, {
                    sessionID: input.sessionID,
                    ...(input.resume === undefined ? {} : { resume: input.resume }),
                  }),
                ).pipe(Effect.mapError(remoteFailure(server)))
                return {
                  output: { sessionID: input.sessionID, interrupted },
                  content: interrupted
                    ? `Interrupted ${input.sessionID} on ${server}.`
                    : `${input.sessionID} on ${server} was already idle.`,
                }
              }
              yield* sessions
                .get(input.sessionID)
                .pipe(Effect.mapError(() => new ToolFailure({ message: `Session not found: ${input.sessionID}` })))
              yield* permission
                .assert({
                  action: "session",
                  resources: [input.sessionID],
                  save: [input.sessionID],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
                .pipe(
                  Effect.mapError((error) =>
                    new ToolFailure({ message: `Session coordination denied: ${input.sessionID}`, error }),
                  ),
                )
              const interrupted = yield* sessions.interrupt(
                input.sessionID,
                input.resume === undefined ? undefined : { resume: input.resume },
              )
              return {
                output: { sessionID: input.sessionID, interrupted },
                content: interrupted ? `Interrupted ${input.sessionID}.` : `${input.sessionID} was already idle.`,
              }
            }),
        })

        editor.add({
          name: "session_wait",
          description: [
            "Waits for a session to go idle, up to the timeout, and reports its last outcome.",
            "Prefer session_spawn with background=true and its completion notification; use this only when you genuinely need to join a run you did not start.",
            "A session you dispatched to a peer server earlier is awaited by its ID alone.",
          ].join("\n"),
          input: WaitInput,
          output: Schema.Struct({
            sessionID: SessionSchema.ID,
            idle: Schema.Boolean,
            outcome: Schema.optionalKey(Schema.Literals(["succeeded", "failed", "interrupted"])),
          }),
          options: { namespace: "opencode", codemode: false, permission: "session" },
          execute: (input, context) =>
            Effect.gen(function* () {
              const server = yield* resolveServer(input.sessionID, input.server)
              if (server !== undefined) {
                yield* assertServer(permission, server, context)
                const timedOut = yield* forgetIfGone(server, input.sessionID, peers.wait(server, input.sessionID)).pipe(
                  Effect.mapError(remoteFailure(server)),
                  Effect.timeoutOption((input.timeout ?? 60) * 1000),
                  Effect.map((option) => option._tag === "None"),
                )
                const outcome = yield* forgetIfGone(
                  server,
                  input.sessionID,
                  peers.outcome(server, input.sessionID),
                ).pipe(Effect.mapError(remoteFailure(server)))
                return {
                  output: {
                    sessionID: input.sessionID,
                    idle: !timedOut,
                    ...(outcome === undefined ? {} : { outcome }),
                  },
                }
              }
              yield* sessions
                .get(input.sessionID)
                .pipe(Effect.mapError(() => new ToolFailure({ message: `Session not found: ${input.sessionID}` })))
              yield* permission
                .assert({
                  action: "session",
                  resources: [input.sessionID],
                  save: [input.sessionID],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
                .pipe(
                  Effect.mapError((error) =>
                    new ToolFailure({ message: `Session coordination denied: ${input.sessionID}`, error }),
                  ),
                )
              const timedOut = yield* sessions
                .wait(input.sessionID)
                .pipe(Effect.mapError(() => new ToolFailure({ message: `Session not found: ${input.sessionID}` })))
                .pipe(Effect.timeoutOption((input.timeout ?? 60) * 1000))
                .pipe(Effect.map((option) => option._tag === "None"))
              const session = yield* sessions
                .get(input.sessionID)
                .pipe(Effect.mapError(() => new ToolFailure({ message: `Session disappeared: ${input.sessionID}` })))
              return {
                output: {
                  sessionID: input.sessionID,
                  idle: !timedOut,
                  ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
                },
              }
            }),
        })
      })
      .pipe(Effect.orDie)

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        if (!event.tools.session_spawn) return
        const names = yield* peers.names
        const peersLine = names.length
          ? `Peer OpenCode servers available for the server parameter: ${names.join(", ")}. It lists, dispatches, sends, stops, and waits against that machine. Sessions dispatched with server remember their placement: send, stop, and wait route to them by session ID alone.`
          : "When the config `servers` map names peer OpenCode servers, these tools accept a server parameter to list, dispatch, send, stop, or wait against that machine. Sessions dispatched with server remember their placement: send, stop, and wait route to them by session ID alone."
        const workspaceNames = Object.keys(Config.latest(yield* config.entries(), "workspaces") ?? {})
        const workspacesLine = workspaceNames.length
          ? ` ssh workspaces available for session_spawn's workspace parameter: ${workspaceNames.join(", ")}. A placed session runs its shell and file tools on that remote host inside the configured directory.`
          : " When the config `workspaces` map names ssh workspaces, session_spawn accepts a workspace parameter to place a session's execution on that remote host."
        event.system.push(
          SystemPart.make(
            [
              "You can coordinate other sessions with opencode_session_list, opencode_session_spawn, opencode_session_send, opencode_session_stop, and opencode_session_wait.",
              "Sessions spawned with session_spawn are independent main-agent sessions; their completion arrives as <peer> messages.",
              peersLine,
              workspacesLine,
            ].join(" "),
          ),
        )
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
