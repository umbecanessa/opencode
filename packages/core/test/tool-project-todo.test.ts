import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { LanguageModel } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Location } from "@opencode/core/location"
import { ProjectTodoTool } from "@opencode/core/tool/plugin/project-todo"
import { Session } from "@opencode/core/session"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Todo } from "@opencode/core/todo"
import { Tool } from "@opencode/core/tool"
import { AbsolutePath } from "@opencode/core/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { location } from "./fixture/location"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const llmLayer = TestLLM.testLayer({ fallback: TestLLM.text("unused", "work") })
const locationLayer = Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") })))

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Tool.node, Session.node, Todo.node, LocationServiceMap.node, Job.node, KV.node, Global.node]),
    [
      Global.node.replace(tempGlobalLayer),
      Location.node.replace(locationLayer),
      offlineModels,
      LayerNodePlatform.llmClient.replace(llmLayer),
      Watcher.node.replace(Watcher.configured({ enabled: false })),
      SessionRunnerModel.node.replace(
        Layer.succeed(SessionRunnerModel.Service, {
          resolve: () =>
            Effect.succeed(
              SessionRunnerModel.resolved(
                LanguageModel.make({ id: "todo", provider: "test", route: OpenAIChat.route }),
                {
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  cost: [],
                  limit: { context: 100_000, output: 8_000 },
                },
              ),
            ),
        }),
      ),
    ],
  ),
)

const sessionID = Session.ID.make("ses_project_todo_test")

const setup = Effect.gen(function* () {
  yield* registerToolPlugin(ProjectTodoTool.Plugin, { event: { subscribe: () => Stream.never } })
  return yield* Tool.Service
})

const call = (registry: Tool.Interface, input: Record<string, unknown>) =>
  executeTool(registry, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call", id: "call-1", name: ProjectTodoTool.name, input },
  })

describe("ProjectTodoTool", () => {
  it.effect("lists every project at once for the star directory", () =>
    Effect.gen(function* () {
      const registry = yield* setup
      const todo = yield* Todo.Service
      yield* todo.add({ directory: "/board-alpha", text: "alpha work" })
      yield* todo.add({ directory: "/board-beta", text: "beta owned", assignee: "ses_beta" })
      const doneRow = yield* todo.add({ directory: "/board-beta", text: "beta done" })
      yield* todo.update({ id: doneRow.id, status: "done" })

      const result = yield* call(registry, { action: "list", directory: "*" })
      expect(result.status).toBe("completed")
      const output = (result as { output: { todos: Array<{ directory: string; assignee?: string }>; message: string } }).output
      expect(output.message).toBe("Todos across all projects.")
      // Rows from both projects, including one owned by another session.
      expect(output.todos.map((item) => item.directory).sort()).toEqual(["/board-alpha", "/board-beta", "/board-beta"])
      expect(output.todos.some((item) => item.assignee === "ses_beta")).toBe(true)
    }),
  )

  it.effect("rejects adds against the star directory", () =>
    Effect.gen(function* () {
      const registry = yield* setup
      const result = yield* call(registry, { action: "add", directory: "*", text: "nowhere land" })
      expect((result as { output: { message: string } }).output.message).toContain("list-only")
      const listed = yield* Todo.Service.use((todo) => todo.list({ directory: "*" }))
      expect(listed).toEqual([])
    }),
  )
})
