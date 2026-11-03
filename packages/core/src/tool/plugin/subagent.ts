export * as SubagentTool from "./subagent.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Predicate, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { Job } from "../../job.js"
import { Model } from "../../model.js"
import { PeerPlacements } from "../../peer-placements.js"
import { PeerServers } from "../../peer-servers.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { SubagentCompletion } from "../../session/subagent-completion.js"
import { SubagentJob } from "../../session/subagent-job.js"
import { assertServer } from "./session.js"
import { SpawnModel } from "./spawn-model.js"

export const name = "subagent"

const backgroundResult = (sessionID: SessionSchema.ID) => ({
  sessionID,
  status: "running" as const,
  output: [
    `The subagent is working in the background (sessionID: ${sessionID}). You will be notified automatically when it finishes.`,
    "DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.",
    "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
    "To send it follow-ups or change its instructions while it runs, call subagent again with this sessionID.",
  ].join("\n"),
})

export const Input = Schema.Struct({
  agent: Schema.String.annotate({
    description:
      "The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead.",
  }),
  description: Schema.String.annotate({ description: "A short 3-5 word label for the task, displayed to the user" }),
  prompt: Schema.String.annotate({ description: "The task for the subagent to perform" }),
  model: Schema.optionalKey(Schema.String).annotate({
    description:
      'NEVER set this unless the user explicitly asks for a particular model or variant. It must be a chat model; image and decision models can\'t run subagents. The value is written as "providerID/modelID", or "providerID/modelID#variant" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first.',
  }),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description: "Send a follow-up to an existing subagent, running or finished. Omit to start a new one.",
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress.",
  }),
  server: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))).annotate({
    description:
      'Name of a peer OpenCode server (config "servers" or a runtime-registered one) to run this subagent there instead of locally. The child is a main-agent session on that server linked to you through this tool: background dispatch arrives as a <peer> completion, foreground returns its final text. With sessionID it sends the prompt there; server, workspace, and directory do not apply to a new placement elsewhere. Follow-up sends to an already-dispatched child route by sessionID alone.',
  }),
  workspace: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))).annotate({
    description:
      "Unsupported here: to place a subagent on an ssh workspace, use session_spawn with workspace, whose children run remotely by inheriting the placed location. Does not apply with server.",
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literals(["completed", "running"]),
  output: Schema.String,
})
export const description = [
  "Spawns an agent in a child session to work on the specified task.",
  "The output includes a sessionID you can pass back later to continue that specific conversation with the subagent.",
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  "Foreground (default) runs the subagent to completion and returns its final response.",
  "Background mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "With server, the child is dispatched to that peer OpenCode server; calling again with its sessionID continues it (prompts and waits go to the peer), and its completion arrives as a <peer> message.",
].join("\n")

export const Plugin = {
  id: "opencode.tool.subagent",
  effect: Effect.fn("SubagentTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const models = yield* Model.Service
    const subagents = yield* SubagentJob.Service
    const peers = yield* PeerServers.Service
    const placements = yield* PeerPlacements.Service

    // Follow-up routing for dispatched children: they have no local session row,
    // so an explicit server or the placement recorded at dispatch routes the call.
    const route = (sessionID: SessionSchema.ID | undefined, server: string | undefined) =>
      server !== undefined
        ? Effect.succeed<string | undefined>(server)
        : sessionID === undefined
          ? Effect.succeed<string | undefined>(undefined)
          : sessions.get(sessionID).pipe(
              Effect.as(undefined),
              Effect.catch(() =>
                placements.locate(sessionID).pipe(Effect.map((found) => (found._tag === "Some" ? found.value.server : undefined))),
              ),
            )

    const resolveModel = Effect.fn("SubagentTool.resolveModel")(function* (input: string) {
      const ref = yield* Effect.try({
        try: () => Model.Ref.parse(input),
        catch: () =>
          new ToolFailure({
            message: `Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`,
          }),
      })
      const model = (yield* models.available()).find(
        (model) => model.providerID === ref.providerID && model.id === ref.id,
      )
      if (model === undefined) {
        const other = (yield* models.available(["image", "decision"])).find(
          (model) => model.providerID === ref.providerID && model.id === ref.id,
        )
        return yield* new ToolFailure({
          message: other
            ? `Model "${ref.providerID}/${ref.id}" is ${other.type === "image" ? "an image" : "a decision"} model; subagents need a chat model. Use the models tool to find one.`
            : `Model "${ref.providerID}/${ref.id}" is not available. Use the models tool to see what is available.`,
        })
      }
      if (ref.variant !== undefined && !model.variants.some((variant) => variant.id === ref.variant))
        return yield* new ToolFailure({
          message:
            model.variants.length === 0
              ? `Model "${ref.providerID}/${ref.id}" has no variants. Omit the variant.`
              : `Variant "${ref.variant}" is not available for "${ref.providerID}/${ref.id}". Available: ${model.variants.map((variant) => variant.id).join(", ")}.`,
        })
      return ref
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const parent = yield* sessions
                .get(context.sessionID)
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                  ),
                )
              let current = parent
              let depth = 0
              while (current.parentID) {
                depth++
                current = yield* sessions
                  .get(current.parentID)
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Parent session not found: ${current.parentID}`, error }),
                    ),
                  )
              }
              const limit = Config.latest(yield* config.entries(), "experimental")?.subagent_depth ?? 1
              if (depth >= limit)
                return yield* new ToolFailure({
                  message: `Subagent depth limit reached (${limit}). Increase "experimental.subagent_depth" to allow nested subagents.`,
                })
              const agent = yield* agents.resolve(input.agent)
              if (agent === undefined) return yield* new ToolFailure({ message: `Unknown agent: ${input.agent}` })
              if (agent.mode === "primary")
                return yield* new ToolFailure({ message: `Agent ${input.agent} cannot run as a subagent` })
              yield* permission
                .assert({
                  action: name,
                  resources: [agent.id],
                  save: [agent.id],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: {
                    type: "tool",
                    messageID: context.messageID,
                    id: context.id,
                  },
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: `Subagent denied: ${agent.id}`, error })))

              // Cross-server children: an explicit server, or a placement recorded by an
              // earlier dispatch of this sessionID, routes the call to a peer machine.
              // The depth and agent-mode checks above still gate the request locally.
              const routed = yield* route(input.sessionID, input.server)
              if (input.workspace !== undefined)
                return yield* new ToolFailure({
                  message:
                    "workspace placement is a session_spawn feature: a session placed on an ssh workspace passes its remote location to its own subagents. The subagent tool dispatches to peer OpenCode servers through server.",
                })
              if (routed !== undefined) {
                const server = routed
                yield* assertServer(permission, server, context)
                const remoteFailure = (detail: string) => (error: unknown) =>
                  new ToolFailure({ message: `${detail} on ${server}: ${error instanceof Error ? error.message : String(error)}`, error })
                if (input.sessionID !== undefined) {
                  const childID = input.sessionID
                  yield* peers
                    .send(server, { sessionID: childID, prompt: input.prompt })
                    .pipe(Effect.mapError(remoteFailure(`Failed to prompt the remote subagent ${childID}`)))
                  if (input.background === true)
                    return {
                      sessionID: childID,
                      status: "running" as const,
                      output: `Prompt delivered to the remote subagent ${childID} on ${server}. No completion notification is sent for follow-ups; call session_wait with this sessionID to join the run and read its reply.`,
                    }
                  // Foreground continuation: join the remote run and return its reply.
                  yield* peers
                    .wait(server, childID)
                    .pipe(
                      Effect.onInterrupt(() => peers.stop(server, { sessionID: childID }).pipe(Effect.ignore)),
                      Effect.mapError(remoteFailure(`Failed to wait for the remote subagent ${childID}`)),
                    )
                  const reply = yield* peers
                    .text(server, childID)
                    .pipe(Effect.mapError(remoteFailure(`Failed to read the remote subagent reply`)))
                  return { sessionID: childID, status: "completed" as const, output: reply }
                }
                const requestedModel = input.model
                const remoteModel =
                  requestedModel === undefined
                    ? yield* SpawnModel.ref(Config.latest(yield* config.entries(), "experimental")?.spawn_model)
                    : yield* Effect.try({
                        try: () => Model.Ref.parse(requestedModel),
                        catch: () => new ToolFailure({ message: `Invalid model "${requestedModel}". Use "providerID/modelID#variant".` }),
                      })
                const remoteInput = {
                  title: input.description,
                  prompt: ["You are a subagent dispatched by another session on a peer server.", input.prompt].join("\n"),
                  agent: agent.id,
                  ...(remoteModel === undefined ? {} : { model: remoteModel }),
                }
                if (input.background === true) {
                  const dispatched = yield* peers
                    .dispatch(server, remoteInput)
                    .pipe(Effect.mapError(remoteFailure("Unable to dispatch the subagent")))
                  yield* placements
                    .record(server, dispatched.sessionID)
                    .pipe(Effect.mapError(remoteFailure("Unable to place the dispatched subagent")))
                  const recovery = {
                    kind: "peer_remote" as const,
                    parentSessionID: context.sessionID,
                    childSessionID: dispatched.sessionID,
                    server,
                    agent: agent.name,
                    description: input.description,
                  }
                  // The local job is only the completion observer: its run waits on
                  // the peer and survives restarts through restart recovery.
                  yield* jobs.start({
                    id: dispatched.sessionID,
                    type: "subagent",
                    title: input.description,
                    recovery,
                    run: peers.watch(server, dispatched.sessionID),
                  })
                  yield* context.progress({ sessionID: dispatched.sessionID, status: "running" })
                  yield* subagents.background(recovery)
                  return {
                    sessionID: dispatched.sessionID,
                    status: "running" as const,
                    output: [
                      `The remote subagent is working on ${server} (sessionID: ${dispatched.sessionID}). You will be notified automatically when it finishes.`,
                      "DO NOT sleep, poll for progress, ask the peer for status, or duplicate this subagent's work.",
                      `To send it follow-ups, call subagent again with this sessionID: the placement routes prompts to ${server}.`,
                    ].join("\n"),
                  }
                }
                const result = yield* peers
                  .spawn(server, remoteInput)
                  .pipe(Effect.mapError(remoteFailure("Unable to dispatch the subagent")))
                yield* placements
                  .record(server, result.sessionID)
                  .pipe(Effect.mapError(remoteFailure("Unable to place the dispatched subagent")))
                if (result.outcome === "failed")
                  return yield* new ToolFailure({
                    message: `Remote subagent failed (sessionID: ${result.sessionID} on ${server})`,
                  })
                if (result.outcome === "interrupted")
                  return yield* new ToolFailure({
                    message: `Remote subagent was interrupted (sessionID: ${result.sessionID} on ${server})`,
                  })
                return {
                  sessionID: result.sessionID,
                  status: "completed" as const,
                  output: result.text ?? SubagentCompletion.NO_TEXT,
                }
              }

              const existing =
                input.sessionID === undefined
                  ? undefined
                  : yield* sessions
                      .get(input.sessionID)
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new ToolFailure({ message: `Subagent session not found: ${input.sessionID}`, error }),
                        ),
                      )
              if (existing !== undefined && existing.parentID !== context.sessionID)
                return yield* new ToolFailure({
                  message: `Session ${existing.id} is not a child of the current session`,
                })
              const override = input.model === undefined ? undefined : yield* resolveModel(input.model)
              // Continuing with a different agent switches the child, mirroring create semantics
              // where an explicit model wins over the agent's configured model, which wins over the inherited one.
              if (existing !== undefined) {
                const switched = existing.agent !== agent.id
                const model = override ?? (switched ? agent.model : undefined)
                yield* Effect.all([
                  switched ? sessions.switchAgent({ sessionID: existing.id, agent: agent.id }) : Effect.void,
                  model === undefined ? Effect.void : sessions.switchModel({ sessionID: existing.id, model }),
                ]).pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to switch subagent session: ${existing.id}`, error }),
                  ),
                )
              }

              // Spawn default: when neither the call nor the agent config names a
              // model, start the child on the fleet-wide spawn model rather than
              // inheriting a parent that may run a hand-picked one.
              const fallback = yield* SpawnModel.ref(Config.latest(yield* config.entries(), "experimental")?.spawn_model)
              const fallbackAvailable =
                fallback === undefined ||
                (yield* models.available()).some((m) => m.providerID === fallback.providerID && m.id === fallback.id)
              const model = override ?? agent.model ?? (fallbackAvailable ? fallback : undefined) ?? parent.model
              const child =
                existing ??
                (yield* sessions
                  .create({
                    parentID: context.sessionID,
                    title: input.description,
                    agent: agent.id,
                    model,
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                    ),
                  ))

              const background = input.background === true
              yield* context.progress({ sessionID: child.id, status: "running" })

              // Standard prompt admission outside the job: Job.start joining a running child skips
              // its run effect, and the default wake starts an idle child or steers a running one.
              yield* sessions
                .prompt({
                  sessionID: child.id,
                  text:
                    existing === undefined
                      ? ["You are a subagent spawned by another session.", input.prompt].join("\n")
                      : input.prompt,
                  ...(background && existing === undefined ? { resume: false } : {}),
                })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to prompt subagent: ${child.id}`, error }),
                  ),
                )

              const recovery = {
                kind: "subagent" as const,
                parentSessionID: context.sessionID,
                childSessionID: child.id,
                agent: agent.name,
                description: input.description,
              }
              yield* subagents.start(recovery)

              if (background) {
                yield* subagents.background(recovery)
                return backgroundResult(child.id)
              }

              const result = yield* jobs.block({ id: child.id, sessionID: context.sessionID }).pipe(
                Effect.onInterrupt(() =>
                  Effect.all([sessions.interrupt(child.id), jobs.cancel(child.id)], {
                    discard: true,
                  }),
                ),
              )
              if (result?.type === "backgrounded") {
                yield* subagents.notify(recovery, result.info.started_at)
                return backgroundResult(child.id)
              }
              // Failure surfaces keep the sessionID visible so the model can continue the child.
              if (result?.info.status === "error")
                return yield* new ToolFailure({
                  message: `Subagent failed (sessionID: ${child.id}): ${result.info.error ?? "unknown error"}`,
                })
              if (result?.info.status === "cancelled")
                return yield* new ToolFailure({ message: `Subagent cancelled (sessionID: ${child.id})` })
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
                    ? `<subagent sessionID="${output.sessionID}" state="completed">\n${output.output}\n</subagent>`
                    : output.output,
                metadata: { sessionID: output.sessionID, status: output.status },
              })),
            ),
        }),
      )
      .pipe(Effect.orDie)

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.sync(() => {
        if (event.tool !== name || !Predicate.isObject(event.input)) return
        if (event.input.model !== "" && event.input.sessionID !== "" && event.input.server !== "" && event.input.workspace !== "")
          return
        const input = { ...event.input }
        if (input.model === "") delete input.model
        if (input.sessionID === "") delete input.sessionID
        if (input.server === "") delete input.server
        if (input.workspace === "") delete input.workspace
        event.input = input
      }),
    )

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const tool = event.tools[name]
        if (!tool) return
        const selected = yield* agents.resolve(event.agent)
        if (!selected) return
        const available = (yield* agents.list())
          .filter(
            (agent) =>
              agent.mode !== "primary" &&
              !agent.hidden &&
              Permission.evaluate(name, agent.id, selected.permissions).effect !== "deny",
          )
          .toSorted((a, b) => a.id.localeCompare(b.id))
        if (available.length === 0) return
        tool.description = [
          tool.description,
          "",
          "Available subagents:",
          ...available.map(
            (agent) =>
              `- ${agent.id}: ${agent.description ?? "This subagent should only be called when explicitly requested."}`,
          ),
        ].join("\n")
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
