import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Generate } from "@opencode/core/generate"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Voice } from "@opencode/core/voice"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Effect, Layer, Schedule } from "effect"
import { LanguageModel, LLMClient } from "../../ai/src/effect"
import { OpenAIChat } from "../../ai/src/protocols/openai-chat"
import { TestLLM } from "../../ai/src/testing"
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

it.live(
  "renders diarized segments as speaker turns",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-voice-speaker-")))
      const global = path.join(tmp.path, "global")
      yield* Effect.promise(() => fs.mkdir(global))
      // A diarized meeting: the wrapper labels its segments with cluster indexes.
      const whisper = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          if (!new URL(request.url).pathname.endsWith("/audio/transcriptions"))
            return new Response("not found", { status: 404 })
          return Response.json({
            text: "hello there how is it going thanks fine",
            language: "en",
            speakers: 2,
            segments: [
              { id: 0, start: 0, end: 2, speaker: "0", text: " hello there" },
              { id: 1, start: 2, end: 4, speaker: "1", text: " how is it going" },
              { id: 2, start: 4, end: 6, speaker: "0", text: " thanks fine" },
            ],
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
        { overrides: [Generate.node.replace(generate)] },
      )
      const send = (pathname: string, init?: RequestInit) =>
        Effect.promise(() => handler(new Request(`http://opencode.local${pathname}`, init)))
      const upload = yield* send("/api/experimental/fs/write?path=" + encodeURIComponent(path.join(global, "voice", "meeting.mp3")), {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]),
      })
      expect(upload.status).toBe(200)
      const audioPath = ((yield* Effect.promise(() => upload.json())) as { data: { path: string } }).data.path
      expect(
        (
          yield* send("/api/experimental/voice/transcribe", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ audioPath, recordingId: "20261113meeting", itemId: "msg_voice_s1", duration: 6 }),
          })
        ).status,
      ).toBe(200)
      const item = yield* Effect.gen(function* () {
        const inbox = yield* send("/api/session/ses_voice_inbox/inbox")
        const entries = ((yield* Effect.promise(() => inbox.json())) as {
          data: Array<{ id: string; payload: { text: string } }>
        }).data
        const found = entries.find((entry) => entry.id === "msg_voice_s1")
        if (found === undefined) return yield* Effect.fail("pending")
        return found
      }).pipe(Effect.retry(Schedule.spaced("50 millis")), Effect.timeout("30 seconds"))
      // 0-based cluster indexes become 1-based "Speaker N" turns, and the
      // timestamped timeline carries the same labels.
      expect(item.payload.text).toContain("Transcript:\nSpeaker 1: hello there")
      expect(item.payload.text).toContain("Speaker 2: how is it going")
      expect(item.payload.text).toContain("[0:02] (Speaker 2) how is it going")
    }),
  { timeout: 45_000 },
)

it.live(
  "dictates a base64 clip synchronously with the configured transcriber",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-voice-dictate-")))
      const global = path.join(tmp.path, "global")
      yield* Effect.promise(() => fs.mkdir(global))
      let calls = 0
      const whisper = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          if (!new URL(request.url).pathname.endsWith("/audio/transcriptions"))
            return new Response("not found", { status: 404 })
          calls += 1
          if (calls === 2)
            // Whisper over silence: confident filler with garbage confidence, no duration of
            // its own. Must come back as empty text, not "Thank you." in the composer.
            return Response.json({
              text: "Thank you.",
              language: "en",
              segments: [{ id: 0, start: 0, end: 2.4, text: " Thank you.", avg_logprob: -5.5 }],
            })
          return Response.json({
            text: "ship the dictate endpoint",
            language: "en",
            segments: [
              { id: 0, start: 0, end: 1.5, speaker: "0", text: " ship the" },
              { id: 1, start: 1.5, end: 3, speaker: "1", text: " dictate endpoint" },
            ],
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
        { overrides: [Generate.node.replace(generate)] },
      )
      const send = (pathname: string, init?: RequestInit) =>
        Effect.promise(() => handler(new Request(`http://opencode.local${pathname}`, init)))

      const dictated = yield* send("/api/experimental/voice/dictate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audio: Buffer.from("fake webm bytes").toString("base64") }),
      })
      expect(dictated.status).toBe(200)
      const result = (yield* Effect.promise(() => dictated.json())) as {
        data: { text: string; language?: string; segments?: Array<{ start: number; text: string; speaker?: string }> }
      }
      expect(result.data.text).toBe("ship the dictate endpoint")
      expect(result.data.language).toBe("en")
      // Segments arrive with diarizer labels intact, so the client can render speakers.
      expect(result.data.segments?.map((segment) => segment.speaker)).toEqual(["0", "1"])

      // A silent clip's hallucinated filler is gated to empty text, which the composer
      // renders as its "No speech detected" notice rather than committing into the prompt.
      const silentDictated = yield* send("/api/experimental/voice/dictate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audio: Buffer.from("silent webm bytes").toString("base64") }),
      })
      expect(silentDictated.status).toBe(200)
      expect(((yield* Effect.promise(() => silentDictated.json())) as { data: { text: string; language?: string; segments?: unknown } }).data).toEqual({
        text: "",
        language: "en",
      })

      // An empty clip is a client mistake, not a transcriber failure.
      expect(
        (
          yield* send("/api/experimental/voice/dictate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ audio: "" }),
          })
        ).status,
      ).toBe(400)
    }),
  { timeout: 45_000 },
)

it.live(
  "proxies the whisper voiceprint store through the speakers endpoints",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-voice-voices-")))
      const global = path.join(tmp.path, "global")
      yield* Effect.promise(() => fs.mkdir(global))
      // A voiceprint store with the wrapper's /v1/voices contract, so the proxy is tested
      // against the real multipart and status semantics rather than a service stub.
      const enrolled: Array<{ name: string; created: number; source?: string }> = []
      const whisper = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const url = new URL(request.url)
          if (!url.pathname.includes("/voices")) return new Response("not found", { status: 404 })
          if (request.method === "GET") return Response.json({ voices: enrolled })
          if (request.method === "DELETE") {
            const name = decodeURIComponent(url.pathname.split("/voices/")[1] ?? "")
            const removed = enrolled.some((voice) => voice.name === name)
            enrolled.splice(
              0,
              enrolled.length,
              ...enrolled.filter((voice) => voice.name !== name),
            )
            return Response.json({ ok: true, removed, voices: enrolled })
          }
          return request.formData().then((form) => {
            const name = String(form.get("name") ?? "").trim()
            if (!name || form.get("file") === null) return Response.json({ error: { message: "missing fields" } }, { status: 400 })
            enrolled.push({ name, created: 1760000000000, ...(form.get("source") ? { source: String(form.get("source")) } : {}) })
            return Response.json({ ok: true, voices: enrolled })
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
        { overrides: [Generate.node.replace(generate)] },
      )
      const send = (pathname: string, init?: RequestInit) =>
        Effect.promise(() => handler(new Request(`http://opencode.local${pathname}`, init)))
      const speakersOf = (response: Response) =>
        Effect.promise(() => response.json()).pipe(Effect.map((body: any) => body.data.speakers as Array<Record<string, unknown>>))

      expect((yield* send("/api/experimental/voice/speakers")).status).toBe(200)
      expect(yield* speakersOf(yield* send("/api/experimental/voice/speakers"))).toEqual([])

      // A phone-mic enrollment arrives as base64 and must reach the wrapper as multipart.
      const enrolledRes = yield* send("/api/experimental/voice/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audio: Buffer.from("fake clip bytes").toString("base64"), name: "Alex", source: "mobile" }),
      })
      expect(enrolledRes.status).toBe(200)
      expect(yield* speakersOf(enrolledRes)).toEqual([{ name: "Alex", created: 1760000000000, source: "mobile" }])

      // Enrolling without a name fails on the server before touching the wrapper.
      expect(
        (
          yield* send("/api/experimental/voice/enroll", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ audio: Buffer.from("x").toString("base64"), name: " " }),
          })
        ).status,
      ).toBe(400)
      // A wrapper refusal (quiet audio) is a client mistake, not a 503.
      expect(
        (
          yield* send("/api/experimental/voice/enroll", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ audio: Buffer.from("x").toString("base64"), name: "" }),
          })
        ).status,
      ).toBe(400)

      const forgotten = yield* send("/api/experimental/voice/speakers/Alex", { method: "DELETE" })
      expect(forgotten.status).toBe(200)
      expect((yield* Effect.promise(() => forgotten.json())) as any).toMatchObject({ data: { removed: true, speakers: [] } })
      // Forgetting a name that was never enrolled is a success with removed: false.
      const nobody = yield* send("/api/experimental/voice/speakers/Nobody", { method: "DELETE" })
      expect(nobody.status).toBe(200)
      expect((yield* Effect.promise(() => nobody.json())) as any).toMatchObject({ data: { removed: false } })
    }),
  { timeout: 45_000 },
)

it.live(
  "waits for the transcriber to come back and still delivers the note",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-voice-revive-")))
      const global = path.join(tmp.path, "global")
      yield* Effect.promise(() => fs.mkdir(global))
      // Grab a free port, then vacate it: the job starts against a dead endpoint (the desktop
      // reboot case) and the mock is revived on that same port mid-wait (wrapper restart).
      const grabber = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
      const whisperPort = grabber.port
      grabber.stop()
      let revived: ReturnType<typeof Bun.serve> | undefined
      yield* Effect.addFinalizer(() => Effect.sync(() => revived?.stop()))
      const handler = yield* ServerFetch.make(
        {
          database: { path: ":memory:" },
          config: {
            directory: global,
            content: JSON.stringify({ experimental: { voice: { transcribe: { url: `http://127.0.0.1:${whisperPort}/v1` } } } }),
          },
          fs: { filewatcher: false },
          models: { fetch: false },
        },
        { overrides: [Generate.node.replace(generate)] },
      )
      const send = (pathname: string, init?: RequestInit) =>
        Effect.promise(() => handler(new Request(`http://opencode.local${pathname}`, init)))

      const upload = yield* send("/api/experimental/fs/write?path=" + encodeURIComponent(path.join(global, "voice", "late.mp3")), {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]),
      })
      expect(upload.status).toBe(200)
      const audioPath = ((yield* Effect.promise(() => upload.json())) as { data: { path: string } }).data.path

      const transcribeRes = yield* send("/api/experimental/voice/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audioPath, recordingId: "20261104revive", itemId: "msg_voice_revive", duration: 3 }),
      })
      expect(transcribeRes.status).toBe(200)

      // The job's first attempt just failed on the dead port and is now polling it; bring the
      // transcriber back so a later probe succeeds and the retry delivers.
      yield* Effect.sleep("500 millis")
      revived = Bun.serve({
        hostname: "127.0.0.1",
        port: whisperPort,
        fetch(request) {
          if (!new URL(request.url).pathname.endsWith("/audio/transcriptions")) return new Response("not found", { status: 404 })
          return Response.json({
            text: "the clip survived the reboot",
            language: "en",
            segments: [{ id: 0, start: 0, end: 2.5, text: "the clip survived the reboot" }],
          })
        },
      })

      const item = yield* Effect.gen(function* () {
        const inbox = yield* send("/api/session/ses_voice_inbox/inbox")
        expect(inbox.status).toBe(200)
        const entries = ((yield* Effect.promise(() => inbox.json())) as {
          data: Array<{ id: string; payload: { text: string; metadata: Record<string, unknown> } }>
        }).data
        const found = entries.find((entry) => entry.id === "msg_voice_revive")
        if (found === undefined) return yield* Effect.fail("pending")
        return found
      }).pipe(Effect.retry(Schedule.spaced("250 millis")), Effect.timeout("30 seconds"))
      expect(item.payload.text).toContain("the clip survived the reboot")
      expect(item.payload.metadata.recordingId).toBe("20261104revive")
    }),
  { timeout: 60_000 },
)

it.live(
  "gates a silent clip when whisper hallucinates low-confidence text",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-voice-gate-")))
      const global = path.join(tmp.path, "global")
      yield* Effect.promise(() => fs.mkdir(global))
      // Whisper over silence: confident-looking text, no timestamp overflow, but mean logprob far
      // below real speech (-0.4). Only the logprob dimension can distinguish it, which is the point.
      // The second request replays the classic overflow hallucination (27.1s on a 9.1s clip) whose
      // logprob stays healthy — only the duration floor catches it.
      let calls = 0
      const whisper = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          if (!new URL(request.url).pathname.endsWith("/audio/transcriptions"))
            return new Response("not found", { status: 404 })
          calls += 1
          if (calls === 1)
            return Response.json({
              text: "You",
              duration: 6.1,
              language: "en",
              segments: [{ id: 0, start: 0, end: 1.2, text: "You", avg_logprob: -5.2 }],
            })
          if (calls === 3)
            // A real 17-minute meeting: healthy mean like the measured ones (-0.33) with ~1% of
            // audio time in sub-cutoff fragments (a laugh, hold music). Must NOT gate.
            return Response.json({
              text: "Let's go through the roadmap. Thanks everyone.",
              duration: 1000,
              language: "en",
              segments: [
                { id: 0, start: 0, end: 500, text: "Let's go through the roadmap.", avg_logprob: -0.3 },
                { id: 1, start: 500, end: 960, text: "Priorities for next quarter.", avg_logprob: -0.4 },
                { id: 2, start: 960, end: 970, text: "ha ha ha", avg_logprob: -4.9 },
                { id: 3, start: 970, end: 1000, text: "Thanks everyone.", avg_logprob: -0.5 },
              ],
            })
          return Response.json({
            text: "Thank you.",
            duration: 9.1,
            language: "en",
            segments: [{ id: 0, start: 0, end: 27.1, text: "Thank you.", avg_logprob: -0.4 }],
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
        { overrides: [Generate.node.replace(generate)] },
      )
      const send = (pathname: string, init?: RequestInit) =>
        Effect.promise(() => handler(new Request(`http://opencode.local${pathname}`, init)))

      const upload = yield* send("/api/experimental/fs/write?path=" + encodeURIComponent(path.join(global, "voice", "silent.mp3")), {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]),
      })
      expect(upload.status).toBe(200)
      const audioPath = ((yield* Effect.promise(() => upload.json())) as { data: { path: string } }).data.path

      const transcribeRes = yield* send("/api/experimental/voice/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audioPath, recordingId: "20261112silent", duration: 6 }),
      })
      expect(transcribeRes.status).toBe(200)

      const item = yield* Effect.gen(function* () {
        const inbox = yield* send("/api/session/ses_voice_inbox/inbox")
        const entries = ((yield* Effect.promise(() => inbox.json())) as {
          data: Array<{ payload: { metadata: Record<string, unknown> } }>
        }).data
        const found = entries.find((entry) => entry.payload.metadata.recordingId === "20261112silent")
        if (found === undefined) return yield* Effect.fail("pending")
        return found
      }).pipe(Effect.retry(Schedule.spaced("50 millis")), Effect.timeout("30 seconds"))
      expect(item.payload.metadata.summary).toBe("No speech detected — the clip was probably silent.")

      // The overflow hallucination: healthy logprob, segment end far past both durations.
      const overflowUpload = yield* send("/api/experimental/fs/write?path=" + encodeURIComponent(path.join(global, "voice", "overflow.mp3")), {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x01]),
      })
      expect(overflowUpload.status).toBe(200)
      const overflowPath = ((yield* Effect.promise(() => overflowUpload.json())) as { data: { path: string } }).data.path
      expect(
        (yield* send("/api/experimental/voice/transcribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ audioPath: overflowPath, recordingId: "20261112overflow", duration: 9 }),
        })).status,
      ).toBe(200)

      const overflowItem = yield* Effect.gen(function* () {
        const inbox = yield* send("/api/session/ses_voice_inbox/inbox")
        const entries = ((yield* Effect.promise(() => inbox.json())) as {
          data: Array<{ payload: { metadata: Record<string, unknown> } }>
        }).data
        const found = entries.find((entry) => entry.payload.metadata.recordingId === "20261112overflow")
        if (found === undefined) return yield* Effect.fail("pending")
        return found
      }).pipe(Effect.retry(Schedule.spaced("50 millis")), Effect.timeout("30 seconds"))
      expect(overflowItem.payload.metadata.summary).toBe("No speech detected — the clip was probably silent.")

      // The long-meeting false positive (26.12.24 hosts): a 17-min recording whose diarized
      // transcript is complete but where a handful of sub-cutoff fragments used to poison the
      // whole clip via some(). Now the gate weighs low-confidence share of audio time.
      const meetingUpload = yield* send("/api/experimental/fs/write?path=" + encodeURIComponent(path.join(global, "voice", "meeting.mp3")), {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x02]),
      })
      expect(meetingUpload.status).toBe(200)
      const meetingPath = ((yield* Effect.promise(() => meetingUpload.json())) as { data: { path: string } }).data.path
      expect(
        (yield* send("/api/experimental/voice/transcribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ audioPath: meetingPath, recordingId: "20261113meeting", duration: 1000 }),
        })).status,
      ).toBe(200)

      const meetingItem = yield* Effect.gen(function* () {
        const inbox = yield* send("/api/session/ses_voice_inbox/inbox")
        const entries = ((yield* Effect.promise(() => inbox.json())) as {
          data: Array<{ payload: { metadata: Record<string, unknown> } }>
        }).data
        const found = entries.find((entry) => entry.payload.metadata.recordingId === "20261113meeting")
        if (found === undefined) return yield* Effect.fail("pending")
        return found
      }).pipe(Effect.retry(Schedule.spaced("50 millis")), Effect.timeout("30 seconds"))
      expect(meetingItem.payload.metadata.summary).not.toBe("No speech detected — the clip was probably silent.")
    }),
  { timeout: 60_000 },
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
    // Accept steers and wakes the target session, so the accept starts a real runner drain.
    // Stub the model layer (like session-instances.test.ts) so the drain answers with an
    // immediate stop instead of reaching the network the harness guards.
    const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer({ fallback: TestLLM.stop() })))
    const runnerModel = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "voice-test-model", provider: "test", route: OpenAIChat.route }),
      { capabilities: { tools: true, input: ["text"], output: ["text"] }, cost: [], limit: { context: 200_000, output: 8_192 } },
    )
    const handler = yield* ServerFetch.make(
      {
        database: { path: ":memory:" },
        config: { directory: global },
        fs: { filewatcher: false },
        models: { fetch: false },
      },
      {
        overrides: [
          Voice.node.replace(voice),
          Generate.node.replace(generate),
          llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
          SessionRunnerModel.node.replace(Layer.succeed(SessionRunnerModel.Service, { resolve: () => Effect.succeed(runnerModel) })),
        ],
      },
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
    // The accept steers and wakes the target: the note is delivered into the session promptly
    // (gone from its undelivered inbox), not parked until the run happens to end.
    yield* Effect.gen(function* () {
      const targetInboxRes = yield* get(`/api/session/${target}/inbox`)
      const targetInbox = (yield* Effect.promise(() => targetInboxRes.json())) as { data: { type: string }[] }
      if (targetInbox.data.filter((entry) => entry.type === "synthetic").length !== 0) return yield* Effect.fail("undelivered")
    }).pipe(Effect.retry(Schedule.spaced("100 millis")), Effect.timeout("30 seconds"))
    // Accept also archives: the transcript is a markdown file in the target project's repo,
    // which is what survives a later compaction of this session.
    const acceptedArchive = yield* Effect.promise(() =>
      fs.readFile(path.join(project, "notes", "transcripts", "20261104move.md"), "utf8"),
    )
    expect(acceptedArchive).toContain("# Triage")
    expect(acceptedArchive).toContain("Recording: 20261104move")
    expect(acceptedArchive).toContain("triage me")

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
    // Remember likewise leaves the transcript file in the project and memory points at it.
    const rememberedArchive = yield* Effect.promise(() =>
      fs.readFile(path.join(project, "notes", "transcripts", "20261104mem.md"), "utf8"),
    )
    expect(rememberedArchive).toContain("remember me")
    expect(rememberedArchive).toContain("## Transcript")

    // The todos extracted from an acted-on note become durable project todos that point back at
    // the archive and the recording, so the work outlives the card and the session.
    yield* post("/api/experimental/voice/ingest", {
      transcript: "file the report and call the vendor",
      recordingId: "20261104todos",
      title: "Actions",
      summary: "Two follow-ups from the Pocket note",
      todos: ["file the report", "call the vendor", "  "],
    })
    const withTodos = [...(yield* pendingIDs)][0]
    expect((yield* post("/api/experimental/voice/accept", { itemId: withTodos, sessionID: target })).status).toBe(200)
    const todoRes = yield* get(`/api/experimental/todo?directory=${project}`)
    const todoList = (yield* Effect.promise(() => todoRes.json())) as {
      data: { text: string; directory: string; source: string; description?: string; refs?: { label: string; uri: string }[] }[]
    }
    expect(todoList.data.map((entry) => entry.text).sort()).toEqual(["call the vendor", "file the report"])
    for (const entry of todoList.data) {
      expect(entry.directory).toBe(project)
      expect(entry.source).toBe("voice")
      expect(entry.description).toBe("Two follow-ups from the Pocket note")
      expect(entry.refs?.map((ref) => ref.uri)).toContain(`voice://20261104todos`)
      expect(entry.refs?.map((ref) => ref.uri)).toContain(
        path.join(project, "notes", "transcripts", "20261104todos.md"),
      )
    }
  }),
)
