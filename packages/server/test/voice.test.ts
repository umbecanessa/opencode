import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Generate } from "@opencode/core/generate"
import { Voice } from "@opencode/core/voice"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Effect, Layer, Schedule } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const voice = makeLocationNode({
  service: Voice.Service,
  layer: Layer.succeed(
    Voice.Service,
    Voice.Service.of({
      models: () =>
        Effect.succeed({
          models: [
            { model: "gpt-live-1", provider: "openai", transports: ["webrtc"], available: true },
            { model: "gpt-realtime-2.1", provider: "openai", transports: ["webrtc", "websocket"], available: true },
            { model: "grok-voice-3.0", provider: "xai", transports: ["websocket"], available: false },
            { model: "gemini-3.8-live", provider: "google", transports: ["websocket"], available: false },
          ],
          default: "gpt-live-1",
        }),
      session: (input) => {
        if (input.model === "invalid")
          return Effect.fail(new Voice.InvalidRequestError({ message: "Unsupported voice model" }))
        if (input.model === "unavailable")
          return Effect.fail(new Voice.UnavailableError({ message: "OpenAI API key is required", service: "openai" }))
        return Effect.succeed(
          input.transport.type === "webrtc"
            ? { type: "webrtc" as const, sdp: `answer:${input.model}:${input.transport.sdp}` }
            : {
                type: "websocket" as const,
                url: `wss://api.x.ai/v1/realtime?model=${input.model}`,
                token: "ek_test",
                expiresAt: 1760000000,
              },
        )
      },
    }),
  ),
  deps: [],
})

// A chat model is out of scope for the transcribe path: text fails so enrichment is skipped, the
// same shape as a machine with no configured model.
const generate = makeLocationNode({
  service: Generate.Service,
  layer: Layer.succeed(
    Generate.Service,
    Generate.Service.of({
      text: () => Effect.fail(new Generate.UnavailableError({ message: "no chat model in the voice test" })),
      image: () => Effect.die("unused"),
      hostedImage: () => Effect.die("unused"),
      decisions: () => Effect.die("unused"),
    }),
  ),
  deps: [],
})

it.live("routes experimental voice models and session endpoints", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-voice-endpoint-")))
    const global = path.join(tmp.path, "global")
    yield* Effect.promise(() => fs.mkdir(global))
    const handler = yield* ServerFetch.make(
      {
        database: { path: ":memory:" },
        config: { directory: global },
        fs: { filewatcher: false },
        models: { fetch: false },
      },
      { overrides: [Voice.node.replace(voice)] },
    )
    const modelsRes = yield* Effect.promise(() =>
      handler(new Request("http://opencode.local/api/experimental/voice/models")),
    )
    expect(modelsRes.status).toBe(200)
    expect(yield* Effect.promise(() => modelsRes.json())).toEqual({
      data: {
        models: [
          { model: "gpt-live-1", provider: "openai", transports: ["webrtc"], available: true },
          { model: "gpt-realtime-2.1", provider: "openai", transports: ["webrtc", "websocket"], available: true },
          { model: "grok-voice-3.0", provider: "xai", transports: ["websocket"], available: false },
          { model: "gemini-3.8-live", provider: "google", transports: ["websocket"], available: false },
        ],
        default: "gpt-live-1",
      },
    })

    const post = (body: unknown) =>
      Effect.promise(() =>
        handler(
          new Request("http://opencode.local/api/experimental/voice/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        ),
      )

    const rtcRes = yield* post({
      model: "gpt-live-1",
      session: { voice: "marin" },
      transport: { type: "webrtc", sdp: "v=0", dcid: 4 },
    })
    expect(rtcRes.status).toBe(200)
    expect(yield* Effect.promise(() => rtcRes.json())).toEqual({
      data: { transport: { type: "webrtc", sdp: "answer:gpt-live-1:v=0" } },
    })

    const wsRes = yield* post({ model: "grok-voice-3.0", transport: { type: "websocket" } })
    expect(wsRes.status).toBe(200)
    expect(yield* Effect.promise(() => wsRes.json())).toEqual({
      data: {
        transport: {
          type: "websocket",
          url: "wss://api.x.ai/v1/realtime?model=grok-voice-3.0",
          token: "ek_test",
          expiresAt: 1760000000,
        },
      },
    })

    expect((yield* post({ model: "invalid", transport: { type: "websocket" } })).status).toBe(400)
    expect((yield* post({ model: "unavailable", transport: { type: "websocket" } })).status).toBe(503)
  }),
)

it.live("ingests voice transcripts as pending synthetic inbox items", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-voice-ingest-")))
    const global = path.join(tmp.path, "global")
    yield* Effect.promise(() => fs.mkdir(global))
    const handler = yield* ServerFetch.make(
      {
        database: { path: ":memory:" },
        config: { directory: global },
        fs: { filewatcher: false },
        models: { fetch: false },
      },
      { overrides: [Voice.node.replace(voice)] },
    )
    const ingest = (body: unknown) =>
      Effect.promise(() =>
        handler(
          new Request("http://opencode.local/api/experimental/voice/ingest", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        ),
      )

    const first = yield* ingest({
      transcript: "remember to ship the ingest endpoint",
      itemId: "msg_voice_first",
      title: "Standup notes",
      summary: "Ship the ingest endpoint",
      todos: ["ship the ingest endpoint"],
      segments: [{ start: 0, end: 2.5, speaker: "S1", text: "remember to ship the ingest endpoint" }],
      device: "PKT01_GREY_264267d2",
      recordingId: "20261104161653",
      suggestedProject: "opencode",
    })
    expect(first.status).toBe(200)
    const firstData = (yield* Effect.promise(() => first.json())).data
    expect(firstData.type).toBe("synthetic")
    expect(firstData.sessionID).toBe("ses_voice_inbox")
    expect(firstData.id).toBe("msg_voice_first")
    expect(firstData.delivery).toBe("queue")
    expect(firstData.payload.text).toContain("Transcript:\nremember to ship the ingest endpoint")
    expect(firstData.payload.text).toContain("[0:00] (S1) remember to ship the ingest endpoint")
    expect(firstData.payload.description).toBe("Standup notes")
    expect(firstData.payload.metadata).toMatchObject({
      source: "voice",
      device: "PKT01_GREY_264267d2",
      recordingId: "20261104161653",
      suggestedProject: "opencode",
      todos: ["ship the ingest endpoint"],
    })

    // Retrying the same item id is idempotent: the first admission wins.
    const retry = yield* ingest({ transcript: "changed after the device resent", itemId: "msg_voice_first" })
    expect(retry.status).toBe(200)
    const retryData = (yield* Effect.promise(() => retry.json())).data
    expect(retryData.id).toBe("msg_voice_first")
    expect(retryData.payload.text).toContain("remember to ship the ingest endpoint")

    // A later recording without an item id lands in the same adopted Voice Inbox session.
    const second = yield* ingest({ transcript: "second recording" })
    expect(second.status).toBe(200)
    expect((yield* Effect.promise(() => second.json())).data.sessionID).toBe("ses_voice_inbox")

    // An explicit session that does not exist is a 404, not an implicit inbox creation.
    expect((yield* ingest({ transcript: "orphan", sessionID: "ses_missing" })).status).toBe(404)

    // Malformed payloads (missing transcript) are rejected at the boundary.
    expect((yield* ingest({ title: "no transcript" })).status).toBe(400)
  }),
)

it.live(
  "transcribes uploaded audio into a pending voice note",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-voice-transcribe-")))
    const global = path.join(tmp.path, "global")
    yield* Effect.promise(() => fs.mkdir(global))
    // Stub for a local whisper server speaking the OpenAI /audio/transcriptions contract.
    const whisper = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (!new URL(request.url).pathname.endsWith("/audio/transcriptions"))
          return new Response("not found", { status: 404 })
        return Response.json({
          text: "remember to ship the transcribe job",
          language: "en",
          segments: [{ id: 0, start: 0, end: 2.5, text: "remember to ship the transcribe job" }],
        })
      },
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => whisper.stop()))
    const handler = yield* ServerFetch.make(
      {
        database: { path: ":memory:" },
        config: {
          directory: global,
          content: JSON.stringify({ experimental: { voice: { transcribe: { url: `http://127.0.0.1:${whisper.port}/v1` } } } }),
        },
        fs: { filewatcher: false },
        models: { fetch: false },
      },
      // The best-effort enrichment chat model is stubbed to fail: the harness guards network, and
      // the transcript must reach the inbox whether or not a summary model exists.
      { overrides: [Generate.node.replace(generate)] },
    )
    const send = (pathname: string, init?: RequestInit) =>
      Effect.promise(() => handler(new Request(`http://opencode.local${pathname}`, init)))

    // The mobile collector uploads the recording through the raw-bytes route it already knows.
    // An absolute path keeps the artifact in the test's own tmpdir instead of the server process cwd.
    const upload = yield* send("/api/experimental/fs/write?path=" + encodeURIComponent(path.join(global, "voice", "mock.mp3")), {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]),
    })
    expect(upload.status).toBe(200)
    const audioPath = ((yield* Effect.promise(() => upload.json())) as { data: { path: string } }).data.path

    const transcribeRes = yield* send("/api/experimental/voice/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioPath,
        recordingId: "20261104mock",
        itemId: "msg_voice_t1",
        device: "PKT01_GREY_264267d2",
        duration: 3,
      }),
    })
    expect(transcribeRes.status).toBe(200)
    const started = (yield* Effect.promise(() => transcribeRes.json())) as { data: { sessionID: string; jobID: string } }
    expect(started.data.sessionID).toBe("ses_voice_inbox")
    expect(started.data.jobID).toBe("voice_20261104mock")

    // The job reads the file, hits the whisper stub, and admits the note; enrichment is skipped
    // in this harness (no chat model), which must not lose the transcript.
    const item = yield* Effect.gen(function* () {
      const inbox = yield* send("/api/session/ses_voice_inbox/inbox")
      expect(inbox.status).toBe(200)
      const entries = ((yield* Effect.promise(() => inbox.json())) as {
        data: Array<{ id: string; type: string; delivery: string; payload: { text: string; metadata: Record<string, unknown> } }>
      }).data
      const found = entries.find((entry) => entry.id === "msg_voice_t1")
      if (found === undefined) return yield* Effect.fail("pending")
      return found
    }).pipe(Effect.retry(Schedule.spaced("50 millis")), Effect.timeout("30 seconds"))
    expect(item.type).toBe("synthetic")
    expect(item.delivery).toBe("queue")
    expect(item.payload.text).toContain("Transcript:\nremember to ship the transcribe job")
    expect(item.payload.text).toContain("[0:00] remember to ship the transcribe job")
    expect(item.payload.metadata).toMatchObject({
      source: "voice",
      device: "PKT01_GREY_264267d2",
      recordingId: "20261104mock",
    })

    // The device retrying with the same recording id is accepted and deduplicates by job id.
    const retry = yield* send("/api/experimental/voice/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audioPath, recordingId: "20261104mock", itemId: "msg_voice_t1" }),
    })
    expect(retry.status).toBe(200)
    expect(
      ((yield* Effect.promise(() => retry.json())) as { data: { jobID: string } }).data.jobID,
    ).toBe("voice_20261104mock")

    // An explicit unknown session fails synchronously instead of deferring to the job.
    expect(
      (yield* send("/api/experimental/voice/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audioPath, sessionID: "ses_missing" }),
      })).status,
    ).toBe(404)
    }),
  { timeout: 45_000 },
)

it.live("routes pending voice notes to sessions or project memory", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-voice-triage-")))
    const global = path.join(tmp.path, "global")
    const project = path.join(tmp.path, "project")
    yield* Effect.promise(async () => {
      await fs.mkdir(global)
      await fs.mkdir(project)
    })
    const handler = yield* ServerFetch.make(
      {
        database: { path: ":memory:" },
        config: { directory: global },
        fs: { filewatcher: false },
        models: { fetch: false },
      },
      { overrides: [Voice.node.replace(voice)] },
    )
    const post = (pathname: string, body: unknown) =>
      Effect.promise(() =>
        handler(
          new Request(`http://opencode.local${pathname}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        ),
      )
    const get = (pathname: string) => Effect.promise(() => handler(new Request(`http://opencode.local${pathname}`)))
    const pendingIDs = Effect.map(
      Effect.flatMap(get("/api/session/ses_voice_inbox/inbox"), (res) =>
        Effect.promise(() => res.json() as Promise<{ data: { id: string }[] }>),
      ),
      (body) => new Set(body.data.map((entry) => entry.id)),
    )

    const createRes = yield* post("/api/session", { location: { directory: project } })
    expect(createRes.ok).toBe(true)
    const target = ((yield* Effect.promise(() => createRes.json())) as { data: { id: string } }).data.id

    // Accept moves the note: it lands in the target session's inbox and leaves the Voice Inbox.
    yield* post("/api/experimental/voice/ingest", { transcript: "triage me", recordingId: "20261104move", title: "Triage" })
    const afterIngest = yield* pendingIDs
    expect(afterIngest.size).toBe(1)
    const accepted = yield* post("/api/experimental/voice/accept", { itemId: [...afterIngest][0], sessionID: target })
    expect(accepted.status).toBe(200)
    const movedData = (yield* Effect.promise(() => accepted.json())) as { data: { sessionID: string; payload: { metadata: Record<string, unknown> } } }
    expect(movedData.data.sessionID).toBe(target)
    expect(movedData.data.payload.metadata.recordingId).toBe("20261104move")
    expect((yield* pendingIDs).size).toBe(0)
    const targetInboxRes = yield* get(`/api/session/${target}/inbox`)
    const targetInbox = (yield* Effect.promise(() => targetInboxRes.json())) as { data: { type: string }[] }
    expect(targetInbox.data.filter((entry) => entry.type === "synthetic").length).toBe(1)

    // A consumed note cannot be accepted again.
    expect((yield* post("/api/experimental/voice/accept", { itemId: [...afterIngest][0], sessionID: target })).status).toBe(400)

    // An unknown target session fails on a still-pending note.
    yield* post("/api/experimental/voice/ingest", { transcript: "orphan accept", recordingId: "20261104orphan" })
    const orphan = [...(yield* pendingIDs)][0]
    expect((yield* post("/api/experimental/voice/accept", { itemId: orphan, sessionID: "ses_missing" })).status).toBe(404)
    expect((yield* post("/api/experimental/voice/accept", { itemId: orphan, sessionID: target })).status).toBe(200)
    expect((yield* pendingIDs).size).toBe(0)

    // Remember consumes the note without delivering it anywhere.
    yield* post("/api/experimental/voice/ingest", { transcript: "remember me", recordingId: "20261104mem" })
    const remembered = yield* pendingIDs
    expect(remembered.size).toBe(1)
    const rememberRes = yield* post("/api/experimental/voice/remember", { itemId: [...remembered][0], directory: project })
    expect(rememberRes.status).toBe(200)
    expect((yield* Effect.promise(() => rememberRes.json()))).toEqual({ data: { remembered: true } })
    expect((yield* pendingIDs).size).toBe(0)
  }),
)
