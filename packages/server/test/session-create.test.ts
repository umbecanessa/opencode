import path from "path"
import { expect } from "bun:test"
import { Project } from "@opencode/schema/project"
import { Session } from "@opencode/schema/session"
import { Global } from "@opencode/util/global"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const SessionsResponse = Schema.Struct({ data: Schema.Array(Schema.toEncoded(Session.Info)) })
const ProjectsResponse = Schema.Array(Schema.toEncoded(Project.Info))

it.live("creates a child at its parent's location and lists it under the parent", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const create = (body: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request("http://opencode.local/api/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        )
        expect(response.status).toBe(200)
        return Schema.decodeUnknownSync(SessionResponse)(await response.json()).data
      })
    const parent = yield* create({ title: "Parent" })
    const child = yield* create({ parentID: parent.id, title: "Child", location: { directory: "/unused" } })
    const response = yield* Effect.promise(() =>
      handler(new Request(`http://opencode.local/api/session?parentID=${parent.id}`)),
    )
    expect(response.status).toBe(200)
    const children = Schema.decodeUnknownSync(SessionsResponse)(yield* Effect.promise(() => response.json()))

    expect(child).toMatchObject({ parentID: parent.id, location: parent.location })
    expect(children.data.map((session) => session.id)).toEqual([child.id])
  }).pipe(Effect.scoped),
)

it.live("returns not found when creating a child of a missing session", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const parentID = Session.ID.create()
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parentID, title: "Child" }),
        }),
      ),
    )
    expect(response.status).toBe(404)
    expect(yield* Effect.promise(() => response.json())).toMatchObject({
      _tag: "SessionNotFoundError",
      sessionID: parentID,
    })
  }).pipe(Effect.scoped),
)

it.live("projectless creates land in the config home and never bind the server cwd", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const json = (request: Request) =>
      Effect.promise(() => handler(request)).pipe(Effect.flatMap((response) => Effect.promise(() => response.json())))
    const create = (body: unknown) =>
      json(
        new Request("http://opencode.local/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ).pipe(Effect.map((value) => Schema.decodeUnknownSync(SessionResponse)(value).data))
    // The server's own config home, the same value its Global service resolves.
    const home = path.resolve(process.env.OPENCODE_CONFIG_DIR ?? Global.Path.config)

    const first = yield* create({ title: "Quick one", projectless: true })
    const second = yield* create({ title: "Quick two", projectless: true, location: { directory: "/ignored" } })

    // Both land in the one neutral home; projectless overrides any location.
    expect(path.resolve(first.location.directory)).toBe(home)
    expect(path.resolve(second.location.directory)).toBe(home)
    expect(second.projectID).toBe(first.projectID)

    // The only project row is the stable home row: a projectless create makes no
    // row for the server cwd or for a supplied location.
    const projects = yield* Effect.map(
      json(new Request("http://opencode.local/api/project")),
      (value) => Schema.decodeUnknownSync(ProjectsResponse)(value),
    )
    expect(projects.map((project) => path.resolve(project.canonical))).toEqual([home])

    // Control: the plain create still binds the server's working directory.
    const plain = yield* create({ title: "Plain" })
    expect(path.resolve(plain.location.directory)).toBe(path.resolve(process.cwd()))
    expect(plain.projectID).not.toBe(first.projectID)
  }).pipe(Effect.scoped),
)
