import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Option, Schema } from "effect"
import { createKeyed, usePlugin, type MountedSession } from "@opencode/plugin/gui"
import { ClientError, type SessionInboxSynthetic } from "@opencode/client/promise"
import { getFilename } from "@opencode/util/path"
import { useI18n } from "@opencode/ui/context/i18n"
import { Button } from "@opencode/ui/button"
import { Select } from "@opencode/ui/select"
import { Spinner } from "@opencode/ui/spinner"
import { showToast } from "@opencode/ui/toast"
import type definition from "./index"

/** The server parks every untriaged voice note in this fixed session's inbox. */
const VOICE_INBOX = "ses_voice_inbox"

interface Segment {
  start: number
  end: number
  speaker: string
  text: string
}

interface Note {
  id: string
  sessionID: string
  created: number
  title: string
  summary: string
  text: string
  audioPath: string
  segments: Segment[]
}

interface Rename {
  item: string
  cluster: string
  name: string
}

interface State {
  status: "loading" | "ready" | "error"
  error: string
  outdated: boolean
  notes: Note[]
  sessions: { id: string; title: string }[]
  projects: { directory: string; name: string }[]
  expanded: string[]
  renames: Rename[]
}

/** The diarizer numbers clusters from 0; render those as 1-based "Speaker N" like the timeline does. */
const speakerLabel = (speaker: string) => (/^\d+$/.test(speaker) ? `Speaker ${Number(speaker) + 1}` : speaker)

const isNumeric = (speaker: string) => /^\d+$/.test(speaker)

// The synthetic payload's metadata is untrusted JSON the server stored from the transcriber; these
// schemas are its decode boundary. Undeclared keys (source, device, todos, ...) are ignored.
const Metafields = Schema.Struct({
  title: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  audioPath: Schema.optional(Schema.String),
})

const MetaSegments = Schema.Array(
  Schema.Struct({
    start: Schema.Finite,
    end: Schema.Finite,
    speaker: Schema.optional(Schema.String),
    text: Schema.String,
  }),
)

/** Maps one pending inbox row onto the card's view model. */
const toNote = (item: SessionInboxSynthetic): Note => {
  const metadata = item.payload.metadata

  const fields = Schema.decodeUnknownOption(Metafields)(metadata).pipe(
    Option.getOrElse(() => ({ title: undefined, summary: undefined, audioPath: undefined }) satisfies typeof Metafields.Type),
  )

  const segments = Schema.decodeUnknownOption(MetaSegments)(metadata?.segments).pipe(
    Option.getOrElse((): typeof MetaSegments.Type => []),
  )

  return {
    id: item.id,
    sessionID: item.sessionID,
    created: item.time.created,
    title: fields.title ?? "",
    summary: fields.summary ?? "",
    text: item.payload.text,
    audioPath: fields.audioPath ?? "",
    segments: segments.map((segment) => ({ ...segment, speaker: segment.speaker ?? "" })),
  }
}

/**
 * The voice inbox as a side panel: every pending Pocket note with its summary and transcript, the
 * speaker chips a diarized meeting carries (each one namable into a voiceprint from the note's own
 * audio), and the same accept / remember / dismiss triage the mobile app offers. The server owns
 * the rows; this view only moves them through the experimental voice API.
 */
export default function VoicePanel(props: { session: MountedSession }) {
  const ctx = usePlugin<typeof definition>()
  const i18n = useI18n()
  // Aborts everything this mount started: loads and the writes below.
  const controller = new AbortController()
  onCleanup(() => controller.abort())

  const [store, setStore] = createStore<State>({
    status: "loading",
    error: "",
    outdated: false,
    notes: [],
    sessions: [],
    projects: [],
    expanded: [],
    renames: [],
  })

  const [naming, setNaming] = createSignal("")
  const [cluster, setCluster] = createSignal("")
  const [nameDraft, setNameDraft] = createSignal("")
  const [busy, setBusy] = createSignal("")

  const voice = () => props.session.server.client.experimental.voice
  const timefmt = createMemo(() => new Intl.DateTimeFormat(i18n.locale(), { dateStyle: "medium", timeStyle: "short" }))

  const load = () =>
    props.session.server.client.session.inbox
      .list({ sessionID: VOICE_INBOX }, { signal: controller.signal })
      .then(
        (items) => {
          if (controller.signal.aborted) return
          setStore({
            status: "ready",
            outdated: false,
            error: "",
            notes: items.filter((item) => item.type === "synthetic").map((item) => toNote(item)),
          })
        },
        (cause: unknown) => {
          if (controller.signal.aborted) return

          if (missingRoute(cause)) {
            setStore({ status: "error", outdated: true, error: "" })

            return
          }

          setStore({ status: "error", outdated: false, error: reason(cause) })
        },
      )

  // The accept and remember pickers' options ride along once per connection; they only matter
  // when a card's menu opens, and a failure there leaves an empty menu rather than an error.
  const loadPickers = () => {
    const client = props.session.server.client

    void client.session
      .list({ limit: 50, order: "desc" }, { signal: controller.signal })
      .then(
        (response) => {
          if (controller.signal.aborted) return
          const here = props.session.id

          const others = response.data
            .filter((session) => session.id !== here && session.id !== VOICE_INBOX && session.time.archived === undefined)
            .map((session) => ({ id: session.id, title: session.title ?? "" }))

          setStore("sessions", [{ id: here, title: ctx.t("session.current") }, ...others])
        },
        () => undefined,
      )

    void client.project
      .list({}, { signal: controller.signal })
      .then(
        (projects) => {
          if (controller.signal.aborted) return
          const here = props.session.directory

          const others = projects
            .filter((project) => project.canonical !== here)
            .map((project) => ({ directory: project.canonical, name: project.name ?? getFilename(project.canonical) }))
            .sort((a, b) => a.name.localeCompare(b.name))

          setStore("projects", [{ directory: here, name: ctx.t("project.current") }, ...others])
        },
        () => undefined,
      )
  }

  // Voice notes from the routed server, then a reload whenever the window regains focus, since
  // the recorder admits notes while this panel is not looking.
  createKeyed(
    () => (props.session.server.connected ? props.session.server.id : undefined),
    () => {
      setStore({ status: "loading", outdated: false, error: "", notes: [] })
      void load()
      loadPickers()

      const onfocus = () => void load()
      window.addEventListener("focus", onfocus)
      onCleanup(() => window.removeEventListener("focus", onfocus))
    },
  )

  const fail = (cause: unknown) => {
    if (controller.signal.aborted) return
    showToast({ variant: "error", title: ctx.t("error"), description: reason(cause) })
  }

  const consume = (note: Note) => setStore("notes", (notes) => notes.filter((row) => row.id !== note.id))

  const expanded = (note: Note) => store.expanded.includes(note.id)

  const toggleExpanded = (note: Note) =>
    setStore("expanded", (shown) => (shown.includes(note.id) ? shown.filter((id) => id !== note.id) : [...shown, note.id]))

  const speakers = (note: Note) => [...new Set(note.segments.map((segment) => segment.speaker).filter((speaker) => speaker !== ""))]

  const enrolledName = (note: Note, speaker: string) =>
    store.renames.find((rename) => rename.item === note.id && rename.cluster === speaker)?.name

  const nameFor = (note: Note, speaker: string) => enrolledName(note, speaker) ?? speakerLabel(speaker)

  const startNaming = (note: Note, speaker: string) => {
    setNaming(note.id)
    setCluster(speaker)
    setNameDraft(enrolledName(note, speaker) ?? "")
  }

  const cancelNaming = () => {
    setNaming("")
    setCluster("")
    setNameDraft("")
  }

  // The card "this is Alex" flow: build the voiceprint from the ranges this note's diarization
  // already attributed to that cluster, so nobody has to record anything new.
  const enroll = (note: Note) => {
    const name = nameDraft().trim()
    const speaker = cluster()

    if (name === "" || speaker === "") return
    setBusy(note.id)

    voice()
      .enroll(
        {
          name,
          audioPath: note.audioPath,
          ranges: note.segments
            .filter((segment) => segment.speaker === speaker)
            .map((segment): [number, number] => [segment.start, segment.end]),
          source: "card",
        },
        { signal: controller.signal },
      )
      .then(
        () => {
          if (controller.signal.aborted) return
          setStore("renames", (renames) => [
            ...renames.filter((rename) => !(rename.item === note.id && rename.cluster === speaker)),
            { item: note.id, cluster: speaker, name },
          ])
          cancelNaming()
          showToast({ variant: "success", title: ctx.t("enrolled", { name }) })
        },
        (cause: unknown) => {
          if (controller.signal.aborted) return
          showToast({ variant: "error", title: ctx.t("enroll.failed"), description: reason(cause) })
        },
      )
      .finally(() => setBusy(""))
  }

  const accept = (note: Note, sessionID: string) =>
    voice()
      .accept({ itemId: note.id, sessionID }, { signal: controller.signal })
      .then(
        () => {
          if (controller.signal.aborted) return
          consume(note)
          showToast({ variant: "success", title: ctx.t("accepted") })
        },
        fail,
      )

  const remember = (note: Note, directory: string) =>
    voice()
      .remember({ itemId: note.id, directory }, { signal: controller.signal })
      .then(
        () => {
          if (controller.signal.aborted) return
          consume(note)
          showToast({ variant: "success", title: ctx.t("remembered") })
        },
        fail,
      )

  const dismiss = (note: Note) =>
    props.session.server.client.session.inbox
      .cancel({ sessionID: note.sessionID, inboxID: note.id }, { signal: controller.signal })
      .then(
        () => {
          if (controller.signal.aborted) return
          consume(note)
          showToast({ variant: "success", title: ctx.t("dismissed") })
        },
        fail,
      )

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base">
      <div class="flex shrink-0 items-center gap-1.5 px-3 pb-1.5 pt-2">
        <span class="min-w-0 flex-1 truncate text-12-regular font-medium text-v2-text-text-base">{ctx.t("title")}</span>
        <Button size="small" variant="ghost-muted" icon="refresh" aria-label={ctx.t("refresh")} onClick={() => void load()} />
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto" data-scrollable>
        <Show when={store.status === "loading"}>
          <div class="flex items-center gap-2 px-3 py-2 text-12-regular text-v2-text-text-muted">
            <Spinner class="size-3" /> {ctx.t("loading")}
          </div>
        </Show>
        <Show when={store.status === "error"}>
          <div class="flex flex-col gap-2 px-3 py-2">
            <span class="text-12-regular text-v2-state-fg-danger">
              {store.outdated ? ctx.t("outdated") : store.error || ctx.t("error")}
            </span>
            <Button size="small" variant="ghost" onClick={() => void load()}>
              {ctx.t("retry")}
            </Button>
          </div>
        </Show>
        <Show when={store.status === "ready" && store.notes.length === 0}>
          <div class="px-3 py-2">
            <div class="text-12-regular text-v2-text-text-base">{ctx.t("empty")}</div>
            <div class="mt-1 text-12-regular text-v2-text-text-muted">{ctx.t("empty.hint")}</div>
          </div>
        </Show>
        <For each={store.notes}>
          {(note) => (
            <div class="border-b-[0.5px] border-v2-border-border-muted/60 px-3 py-2">
              <div class="flex items-baseline gap-2">
                <button
                  type="button"
                  class="min-w-0 flex-1 truncate text-start text-12-regular font-medium text-v2-text-text-base"
                  aria-expanded={expanded(note)}
                  title={expanded(note) ? ctx.t("transcript.hide") : ctx.t("transcript")}
                  onClick={() => toggleExpanded(note)}
                >
                  {note.title === "" ? ctx.t("untitled") : note.title}
                </button>
                <span class="shrink-0 text-[10px] leading-[var(--line-height-compact)] text-v2-text-text-muted">
                  {timefmt().format(note.created)}
                </span>
              </div>
              <Show when={note.summary !== "" && !expanded(note)}>
                <p class="line-clamp-2 pt-0.5 text-12-regular leading-[var(--line-height-compact)] text-v2-text-text-muted">
                  {note.summary}
                </p>
              </Show>
              <Show when={expanded(note)}>
                <pre
                  class="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap rounded border-[0.5px] border-v2-border-border-muted p-2 font-mono text-12-regular leading-[var(--line-height-compact)] text-v2-text-text-muted"
                  data-scrollable
                >
                  {note.text}
                </pre>
              </Show>
              <Show when={speakers(note).length > 0}>
                <div class="flex flex-wrap items-center gap-1 pt-1.5">
                  <For each={speakers(note)}>
                    {(speaker) => (
                      <Show
                        when={naming() === note.id && cluster() === speaker}
                        fallback={
                          <button
                            type="button"
                            class="rounded-full border-[0.5px] border-v2-border-border-muted px-1.5 text-[10px] leading-[var(--line-height-compact)] text-v2-text-text-muted"
                            classList={{
                              "transition-colors hover:border-v2-border-border-base hover:text-v2-text-text-base":
                                note.audioPath !== "" && isNumeric(speaker),
                            }}
                            title={note.audioPath !== "" && isNumeric(speaker) ? ctx.t("chip.name") : undefined}
                            disabled={note.audioPath === "" || !isNumeric(speaker)}
                            onClick={() => startNaming(note, speaker)}
                          >
                            {nameFor(note, speaker)}
                          </button>
                        }
                      >
                        <div class="flex items-center gap-1 rounded-full border-[0.5px] border-v2-border-border-base px-1.5 py-0.5">
                          <input
                            type="text"
                            spellcheck={false}
                            autocomplete="off"
                            autofocus
                            aria-label={ctx.t("chip.name")}
                            placeholder={ctx.t("enroll.placeholder")}
                            value={nameDraft()}
                            class="w-24 bg-transparent text-[10px] leading-[var(--line-height-compact)] text-v2-text-text-base outline-none"
                            onInput={(event) => setNameDraft(event.currentTarget.value)}
                            onKeyDown={(event) => {
                              event.stopPropagation()

                              if (event.key === "Enter") enroll(note)

                              if (event.key === "Escape") cancelNaming()
                            }}
                          />
                          <button
                            type="button"
                            class="shrink-0 text-[10px] font-medium text-v2-text-text-base"
                            disabled={busy() !== ""}
                            onClick={() => enroll(note)}
                          >
                            {busy() === note.id ? "…" : ctx.t("enroll")}
                          </button>
                          <button
                            type="button"
                            class="shrink-0 text-[10px] text-v2-text-text-muted"
                            disabled={busy() !== ""}
                            onClick={cancelNaming}
                          >
                            {ctx.t("cancel")}
                          </button>
                        </div>
                      </Show>
                    )}
                  </For>
                </div>
              </Show>
              <div class="flex items-center gap-1.5 pt-2">
                <Select
                  options={store.sessions}
                  value={(option) => option.id}
                  label={(option) => (option.title === "" ? option.id.slice(-6) : option.title)}
                  placeholder={ctx.t("accept")}
                  placement="bottom-start"
                  gutter={4}
                  onSelect={(option) => option !== null && accept(note, option.id)}
                />
                <Select
                  options={store.projects}
                  value={(option) => option.directory}
                  label={(option) => option.name}
                  placeholder={ctx.t("remember")}
                  placement="bottom-start"
                  gutter={4}
                  onSelect={(option) => option !== null && remember(note, option.directory)}
                />
                <span class="ms-auto">
                  <Button size="small" variant="ghost-muted" icon="xmark-small" aria-label={ctx.t("dismiss")} onClick={() => dismiss(note)} />
                </span>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

/** A 404 on the inbox route means the server predates the voice pipeline. */
function missingRoute(cause: unknown) {
  return (
    cause instanceof ClientError &&
    cause.reason === "UnexpectedStatus" &&
    cause.cause instanceof Object &&
    "status" in cause.cause &&
    cause.cause.status === 404
  )
}

function reason(cause: unknown) {
  if (cause instanceof Error) return cause.message

  return String(cause)
}
