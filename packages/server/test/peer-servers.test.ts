import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

const put = (base: string, headers: Record<string, string>, body: unknown) =>
  Effect.promise(() =>
    fetch(`${base}/api/experimental/peer-servers`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )

it.live("registers the peer server map", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-peer-servers-")))
    const server = yield* startServer(path.join(tmp.path, "global"))
    const response = yield* put(server.base, server.headers, {
      servers: { "wsl:Debian": { url: "http://127.0.0.1:4196", credential: "pw" }, plain: { url: "http://host:4096" } },
    })
    expect(response.status).toBe(204)
  }),
)

it.live("rejects a peer server entry without a url", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-peer-servers-")))
    const server = yield* startServer(path.join(tmp.path, "global"))
    const response = yield* put(server.base, server.headers, { servers: { broken: {} } })
    expect(response.status).toBe(400)
  }),
)
