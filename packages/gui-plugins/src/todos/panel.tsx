import { batch, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createKeyed, usePlugin, type MountedSession } from "@opencode/plugin/gui"
import { FileOpen } from "@opencode/plugin/gui/file"
import { ClientError, type TodoInfo } from "@opencode/client/promise"
import { getFilename } from "@opencode/util/path"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Spinner } from "@opencode/ui/spinner"
import { showToast } from "@opencode/ui/toast"
import type definition from "./index"

interface State {
  status: "loading" | "ready" | "error"
  error: string
  outdated: boolean
  items: TodoInfo[]
}

interface Group {
  directory: string
  name: string
  here: boolean
  open: TodoInfo[]
  done: TodoInfo[]
}

/** A uri without a scheme reads as a workspace file path; everything else stays a plain chip. */
const isFileRef = (uri: string) => !uri.includes("://")

/**
 * Durable project todos: every project's open items, grouped with the routed project first, plus a
 * collapsed done list per group. The server owns the rows (voice triage and the agent's todo tool
 * write them too); this view adds, edits, completes, and deletes through the experimental todo API.
 */
export default function TodosPanel(props: { session: MountedSession }) {
  const ctx = usePlugin<typeof definition>()
  const fileOpen = ctx.use(FileOpen)
  // Aborts everything this mount started: loads and the writes below.
  const controller = new AbortController()
  onCleanup(() => controller.abort())

  const [store, setStore] = createStore<State>({ status: "loading", error: "", outdated: false, items: [] })
  const [draft, setDraft] = createSignal("")
  const [editing, setEditing] = createSignal("")
  const [editDraft, setEditDraft] = createSignal("")
  const [doneOpen, setDoneOpen] = createSignal<string[]>([])

  const client = () => props.session.server.client.experimental.todo

  const load = () =>
    client()
      .list({}, { signal: controller.signal })
      .then(
        (rows) => {
          if (controller.signal.aborted) return
          setStore({ status: "ready", outdated: false, error: "", items: rows })
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

  // All projects' todos from the routed server: the snapshot, then a reload whenever the window
  // regains focus, since voice triage and agents file items while this panel is not looking.
  createKeyed(
    () => (props.session.server.connected ? props.session.server.id : undefined),
    () => {
      setStore({ status: "loading", items: [] })
      void load()

      const onfocus = () => void load()
      window.addEventListener("focus", onfocus)
      onCleanup(() => window.removeEventListener("focus", onfocus))
    },
  )

  const groups = createMemo<Group[]>(() => {
    const byDirectory = new Map<string, TodoInfo[]>()

    for (const item of store.items) {
      const list = byDirectory.get(item.directory)

      if (list) list.push(item)
      else byDirectory.set(item.directory, [item])
    }

    return [...byDirectory]
      .map(([directory, items]) => ({
        directory,
        name: getFilename(directory),
        here: directory === props.session.directory,
        open: items.filter((item) => item.status === "open"),
        done: items.filter((item) => item.status === "done"),
      }))
      .sort((a, b) => Number(b.here) - Number(a.here) || a.name.localeCompare(b.name))
  })

  const fail = (cause: unknown) => {
    if (controller.signal.aborted) return
    showToast({ variant: "error", title: ctx.t("error"), description: reason(cause) })
  }

  const replace = (next: TodoInfo) => setStore("items", (items) => items.map((item) => (item.id === next.id ? next : item)))

  const add = () => {
    const text = draft().trim()

    if (text === "") return

    client()
      .add({ directory: props.session.directory, text }, { signal: controller.signal })
      .then(
        (data) => {
          if (controller.signal.aborted) return
          setStore("items", (items) => [...items, data])
        },
        fail,
      )
    setDraft("")
  }

  const toggle = (item: TodoInfo) =>
    client()
      .update({ id: item.id, status: item.status === "done" ? "open" : "done" }, { signal: controller.signal })
      .then(
        (data) => {
          if (controller.signal.aborted) return
          replace(data)
        },
        fail,
      )

  const saveEdit = (item: TodoInfo) => {
    const text = editDraft().trim()
    batch(() => {
      setEditing("")
      setEditDraft("")
    })

    if (text === "" || text === item.text) return

    client()
      .update({ id: item.id, text }, { signal: controller.signal })
      .then(
        (data) => {
          if (controller.signal.aborted) return
          replace(data)
        },
        fail,
      )
  }

  const remove = (item: TodoInfo) =>
    client()
      .remove({ id: item.id }, { signal: controller.signal })
      .then(
        () => {
          if (controller.signal.aborted) return
          setStore("items", (items) => items.filter((row) => row.id !== item.id))
        },
        fail,
      )

  const openRef = (uri: string) => {
    const live = fileOpen()

    if (live.status === "active") live.value.open(props.session, uri)
  }

  const showDone = (group: Group) => doneOpen().includes(group.directory)

  const toggleDone = (group: Group) =>
    setDoneOpen((shown) => (shown.includes(group.directory) ? shown.filter((at) => at !== group.directory) : [...shown, group.directory]))

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base">
      <div class="flex shrink-0 items-center gap-1.5 px-3 pb-1.5 pt-2">
        <div class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border-[0.5px] border-v2-border-border-muted px-2 py-1">
          <input
            type="text"
            spellcheck={false}
            autocomplete="off"
            aria-label={ctx.t("add.aria")}
            placeholder={ctx.t("add.placeholder")}
            value={draft()}
            class="min-w-0 flex-1 bg-transparent text-12-regular text-v2-text-text-base outline-none"
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              event.stopPropagation()

              if (event.key === "Enter") add()
            }}
          />
        </div>
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
        <Show when={store.status === "ready" && store.items.length === 0}>
          <div class="px-3 py-2">
            <div class="text-12-regular text-v2-text-text-base">{ctx.t("empty")}</div>
            <div class="mt-1 text-12-regular text-v2-text-text-muted">{ctx.t("empty.hint")}</div>
          </div>
        </Show>
        <For each={groups()}>
          {(group) => (
            <div class="pb-1">
              <div class="flex items-baseline gap-1.5 px-3 pb-0.5 pt-2">
                <span class="truncate text-[10px] font-medium uppercase tracking-wide text-v2-text-text-muted" title={group.directory}>
                  {group.name}
                </span>
                <Show when={group.here}>
                  <span class="shrink-0 text-[10px] text-v2-text-text-muted">· {ctx.t("here")}</span>
                </Show>
              </div>
              <For each={group.open}>{(item) => <Row item={item} label={ctx.t} onToggle={toggle} onEdit={saveEdit} onRemove={remove} openRef={openRef} editing={editing} editDraft={editDraft} setEditDraft={setEditDraft} startEdit={setEditing} t={ctx.t} />}</For>
              <Show when={group.done.length > 0}>
                <button
                  type="button"
                  class="px-3 py-1 text-start text-[10px] font-medium uppercase tracking-wide text-v2-text-text-muted transition-colors hover:text-v2-text-text-base"
                  aria-expanded={showDone(group)}
                  onClick={() => toggleDone(group)}
                >
                  {ctx.plural("done.count", group.done.length)}
                </button>
                <Show when={showDone(group)}>
                  <For each={group.done}>{(item) => <Row item={item} label={ctx.t} onToggle={toggle} onEdit={saveEdit} onRemove={remove} openRef={openRef} editing={editing} editDraft={editDraft} setEditDraft={setEditDraft} startEdit={setEditing} t={ctx.t} />}</For>
                </Show>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

function Row(props: {
  item: TodoInfo
  label: (key: string) => string
  onToggle: (item: TodoInfo) => void
  onEdit: (item: TodoInfo) => void
  onRemove: (item: TodoInfo) => void
  openRef: (uri: string) => void
  editing: () => string
  editDraft: () => string
  setEditDraft: (text: string) => void
  startEdit: (id: string) => void
  t: (key: string) => string
}) {
  const done = () => props.item.status === "done"
  const editing = () => props.editing() === props.item.id

  return (
    <div class="group flex items-start gap-2 border-b-[0.5px] border-v2-border-border-muted/60 px-3 py-1.5 last:border-b-0">
      <button
        type="button"
        class="mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded border-[0.5px] transition-colors"
        classList={{
          "border-v2-border-border-base text-v2-text-text-muted hover:border-v2-text-text-base": !done(),
          "border-v2-state-fg-success bg-v2-state-fg-success/15 text-v2-state-fg-success": done(),
        }}
        aria-label={done() ? props.t("reopen") : props.t("complete")}
        title={done() ? props.t("reopen") : props.t("complete")}
        onClick={() => props.onToggle(props.item)}
      >
        <Show when={done()}>
          <Icon name="check" size="small" />
        </Show>
      </button>
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <Show
          when={!editing()}
          fallback={
            <input
              type="text"
              spellcheck={false}
              autofocus
              aria-label={props.t("edit.save")}
              value={props.editDraft()}
              class="w-full rounded border-[0.5px] border-v2-border-border-base bg-transparent px-1 text-12-regular text-v2-text-text-base outline-none"
              onInput={(event) => props.setEditDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                event.stopPropagation()

                if (event.key === "Enter") props.onEdit(props.item)

                if (event.key === "Escape") props.startEdit("")
              }}
              onBlur={() => props.onEdit(props.item)}
            />
          }
        >
          <button
            type="button"
            class="min-w-0 break-words text-start text-12-regular leading-[var(--line-height-compact)] transition-colors hover:text-v2-text-text-base"
            classList={{ "text-v2-text-text-muted line-through decoration-1": done(), "text-v2-text-text-base": !done() }}
            title={props.item.description ?? props.t("edit.save")}
            onClick={() => {
              props.setEditDraft(props.item.text)
              props.startEdit(props.item.id)
            }}
          >
            {props.item.text}
          </button>
        </Show>
        <Show when={props.item.description && !editing()}>
          <span class="line-clamp-2 text-[10px] leading-[var(--line-height-compact)] text-v2-text-text-muted">{props.item.description}</span>
        </Show>
        <Show when={!editing() && (props.item.refs?.length ?? 0) > 0}>
          <div class="flex flex-wrap items-center gap-1 pt-0.5">
            <For each={props.item.refs ?? []}>
              {(ref) => (
                <Show
                  when={isFileRef(ref.uri)}
                  fallback={
                    <span class="rounded border-[0.5px] border-v2-border-border-muted px-1 text-[10px] text-v2-text-text-muted" title={ref.uri}>
                      {ref.label}
                    </span>
                  }
                >
                  <button
                    type="button"
                    class="rounded border-[0.5px] border-v2-border-border-muted px-1 text-[10px] text-v2-text-text-muted transition-colors hover:text-v2-text-text-base"
                    title={ref.uri}
                    onClick={(event) => {
                      event.stopPropagation()
                      props.openRef(ref.uri)
                    }}
                  >
                    {ref.label}
                  </button>
                </Show>
              )}
            </For>
          </div>
        </Show>
        <span class="text-[10px] uppercase tracking-wide text-v2-text-text-muted/70">{props.t(`source.${props.item.source}`)}</span>
      </div>
      <span class="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Button size="small" variant="ghost-muted" icon="outline-trash" aria-label={props.t("remove")} onClick={() => props.onRemove(props.item)} />
      </span>
    </div>
  )
}

/** A 404 on the list route means the server predates the todo endpoints. */
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
