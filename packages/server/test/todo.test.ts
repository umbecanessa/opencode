import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const root = "/todo-test"

it.live("manages durable project todos over /api/experimental/todo", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-todo-endpoint-")))
    yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "global")))
    const handler = yield* ServerFetch.make({
      database: { path: ":memory:" },
      config: { directory: path.join(tmp.path, "global") },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const call = (method: string, url: string, body?: unknown) =>
      Effect.promise(() =>
        handler(
          new Request(`http://opencode.local${url}`, {
            method,
            ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
          }),
        ),
      )
    const json = (response: Response) => Effect.promise(() => response.json())

    const added = yield* call("POST", "/api/experimental/todo", {
      directory: root,
      text: "Ship the Pocket triage card",
      description: "From the 2026-11-12 recording",
      refs: [{ label: "Transcript", uri: `${root}/notes/transcripts/rec-1.md` }],
      id: "todo_stable_id",
    })
    expect(added.status).toBe(200)
    const first = yield* json(added)
    expect(first.data).toMatchObject({
      id: "todo_stable_id",
      directory: root,
      text: "Ship the Pocket triage card",
      status: "open",
      source: "user",
    })
    expect(first.data.refs).toEqual([{ label: "Transcript", uri: `${root}/notes/transcripts/rec-1.md` }])

    // A retried add with the same id returns the stored row instead of duplicating it.
    const retry = yield* json(yield* call("POST", "/api/experimental/todo", { directory: root, text: "other" , id: "todo_stable_id" }))
    expect(retry.data.id).toBe("todo_stable_id")
    expect(retry.data.text).toBe("Ship the Pocket triage card")

    const blank = yield* call("POST", "/api/experimental/todo", { directory: root, text: "   " })
    expect(blank.status).toBe(400)

    const listed = yield* json(yield* call("GET", `/api/experimental/todo?directory=${root}`))
    expect(listed.data.map((todo: { id: string }) => todo.id)).toEqual(["todo_stable_id"])

    const elsewhere = yield* json(yield* call("GET", "/api/experimental/todo?directory=/todo-test/other"))
    expect(elsewhere.data).toEqual([])

    const completed = yield* json(yield* call("PATCH", "/api/experimental/todo/todo_stable_id", { status: "done" }))
    expect(completed.data.status).toBe("done")
    expect(typeof completed.data.done_at).toBe("number")

    const reopened = yield* json(yield* call("PATCH", "/api/experimental/todo/todo_stable_id", { status: "open" }))
    expect(reopened.data.status).toBe("open")
    expect(reopened.data.done_at).toBeUndefined()

    const edited = yield* json(yield* call("PATCH", "/api/experimental/todo/todo_stable_id", { text: "Ship the triage card" }))
    expect(edited.data.text).toBe("Ship the triage card")
    expect(edited.data.refs).toEqual([{ label: "Transcript", uri: `${root}/notes/transcripts/rec-1.md` }])

    // Rows from every project come back when no directory filters, each carrying its own.
    yield* call("POST", "/api/experimental/todo", { directory: "/todo-test/beta", text: "Beta work" })
    const every = yield* json(yield* call("GET", "/api/experimental/todo?status=open"))
    expect(every.data.map((todo: { directory: string }) => todo.directory).sort()).toEqual([root, "/todo-test/beta"])

    const removed = yield* json(yield* call("DELETE", "/api/experimental/todo/todo_stable_id"))
    expect(removed.data).toEqual({ removed: true })
    const missing = yield* call("DELETE", "/api/experimental/todo/todo_stable_id")
    expect(missing.status).toBe(404)
    expect((yield* json(missing))._tag).toBe("TodoNotFoundError")
  }),
)
