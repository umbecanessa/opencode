import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Document, Info } from "@opencode/schema/config"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { PeerServers } from "@opencode/core/peer-servers"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const peerSession = {
  id: Session.ID.create(),
  location: { directory: "/srv/peer/project" },
  time: { updated: 1 },
}

let requests: { url: string; authorization?: string }[] = []

const httpStub = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname
      if (path === "/api/session" || path.endsWith("/active"))
        requests.push({ url: request.url, authorization: request.headers["authorization"] })
      const body = path === "/api/session" ? { data: [peerSession] } : path.endsWith("/active") ? { data: {} } : {}
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
      )
    }),
  ),
)

// One config document with `servers`, so resolution exercises config-vs-registry precedence.
const configLayer = Config.testLayer([
  new Document({
    type: "document",
    path: AbsolutePath.make("/opencode.json"),
    info: new Info({
      servers: { "config-server": { url: "http://config.invalid", credential: "config-cred" } },
    }),
  }),
])

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([PeerServers.node, PeerServers.registryNode]), [
    Config.node.replace(configLayer),
    httpClient.replace(httpStub),
  ]),
)

const register = (entries: Record<string, { url: string; credential?: string }>) =>
  PeerServers.Registry.use((registry) => registry.set(entries))

const reset = <A, E, R>(run: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    requests = []
    return yield* run
  })

const basic = (password: string) => `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

describe("PeerServers registry", () => {
  it.live(
    "resolves a registered server without any config entry",
    reset(
      Effect.gen(function* () {
        const peers = yield* PeerServers.Service
        yield* register({ "wsl:Debian": { url: "http://tunnel.invalid", credential: "tunnel-cred" } })
        const sessions = yield* peers.list("wsl:Debian", {})
        expect(sessions).toEqual([{ id: peerSession.id, directory: "/srv/peer/project", active: false, updated: 1 }])
        expect(requests[0]!.url).toContain("http://tunnel.invalid/api/session")
        expect(requests[0]!.authorization).toBe(basic("tunnel-cred"))
      }),
    ),
  )

  it.live(
    "prefers the config entry over a same-named registration",
    reset(
      Effect.gen(function* () {
        const peers = yield* PeerServers.Service
        yield* register({ "config-server": { url: "http://shadow.invalid" } })
        yield* peers.list("config-server", {})
        expect(requests[0]!.url).toContain("http://config.invalid/api/session")
        expect(requests[0]!.authorization).toBe(basic("config-cred"))
      }),
    ),
  )

  it.live(
    "lists config and registered names when a name resolves nowhere",
    reset(
      Effect.gen(function* () {
        const peers = yield* PeerServers.Service
        yield* register({ "wsl:Debian": { url: "http://tunnel.invalid" } })
        const error = yield* peers.list("nowhere", {}).pipe(Effect.flip)
        expect(error.detail).toContain("Configured servers: config-server, wsl:Debian")
      }),
    ),
  )

  it.live(
    "reports config and registered names through names()",
    reset(
      Effect.gen(function* () {
        const peers = yield* PeerServers.Service
        yield* register({ "ssh:dev": { url: "http://ssh.invalid" } })
        expect(yield* peers.names).toEqual(["config-server", "ssh:dev"])
      }),
    ),
  )
})
