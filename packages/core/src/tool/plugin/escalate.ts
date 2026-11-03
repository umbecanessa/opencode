export * as EscalateTool from "./escalate.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"

export const name = "escalate"

export const Input = Schema.Struct({
  message: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "What the parent needs to decide: the blocker, the options you see, and what you need from it",
  }),
  delivery: Schema.optionalKey(SessionInbox.Delivery).annotate({
    description:
      'steer surfaces this to the parent at its next safe boundary (default); queue waits until the parent would go idle. Use queue for news that does not block your work',
  }),
})

export const Output = Schema.Struct({ parentID: SessionSchema.ID, delivered: Schema.Boolean })

export const description = [
  "Sends a message from this session to the session that spawned it, so the parent can decide something only it can decide.",
  "It is the only channel to the parent agent: the question tool and permission prompts reach the user, and completing is the normal reply. Reserve this for needing the parent's decision, not for status updates.",
  "The message is durable and attributed to this session. A running parent reads it at its next safe boundary; an idle parent wakes up to read it.",
  "Do not wait for a reply after calling it: keep working or end your turn. The parent answers by prompting this session.",
].join("\n")

export const Plugin = {
  id: "opencode.tool.escalate",
  effect: Effect.fn("EscalateTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const permission = yield* Permission.Service

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
              const child = yield* sessions
                .get(context.sessionID)
                .pipe(Effect.mapError(() => new ToolFailure({ message: `Session not found: ${context.sessionID}` })))
              // No target argument: the only session a child may write into
              // unasked is the one that spawned it.
              const parentID = child.parentID
              if (parentID === undefined)
                return yield* new ToolFailure({
                  message: `Session ${context.sessionID} was not spawned by another session, so there is no parent to escalate to. Use session_send with an explicit sessionID to reach a session you know about.`,
                })
              yield* permission
                .assertNotDenied({
                  action: name,
                  resources: [parentID],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: `Escalation denied: ${parentID}`, error })))
              // Durable admission into the parent's inbox: a blocked parent picks
              // this up at its next safe boundary and an idle one is woken.
              yield* sessions
                .synthetic({
                  sessionID: parentID,
                  text: `<escalation sessionID="${context.sessionID}"${child.title === undefined ? "" : ` description="${child.title}"`}>\n${input.message}\n</escalation>`,
                  ...(child.title === undefined ? {} : { description: child.title }),
                  metadata: {
                    source: name,
                    childID: context.sessionID,
                    ...(child.agent === undefined ? {} : { agent: child.agent }),
                  },
                  ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: `Failed to deliver the escalation: ${parentID}` })))
              return {
                output: { parentID, delivered: true },
                content: `Escalated to parent session ${parentID}. It reads this at its next safe boundary: keep working or end your turn instead of waiting for a reply.`,
                metadata: { parentID },
              }
            }),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
