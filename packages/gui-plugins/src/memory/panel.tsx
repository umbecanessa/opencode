import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createKeyed, usePlugin, type MountedSession } from "@opencode/plugin/gui"
import { Memory } from "@opencode/schema/memory"
import { Button } from "@opencode/ui/button"
import { Spinner } from "@opencode/ui/spinner"
import { showToast } from "@opencode/ui/toast"
import type definition from "./index"

interface LinkRow {
  node: Memory.Node
  relation: string
  via: Memory.Node
}

interface Row {
  node: Memory.Node
  via?: Memory.Via
}

type Filter = "all" | Memory.Kind

interface State {
  status: "loading" | "ready" | "error"
  error: string
  overview?: Memory.Overview
  searching: boolean
  results?: Memory.Search
  expanded: string
  linking: boolean
  neighbors: LinkRow[]
  related: Memory.Node[]
}

/**
 * The project knowledge graph: the current records, a search that also reaches their graph
 * neighborhood, and the links of any record you expand. Writes are the agent's; this view only
 * reads and retires records through the server's memory RPC.
 */
export default function MemoryPanel(props: { session: MountedSession }) {
  const ctx = usePlugin<typeof definition>()
  // Aborts everything this mount started: reloads, searches, and the link reads below.
  const controller = new AbortController()
  onCleanup(() => controller.abort())

  const [store, setStore] = createStore<State>({
    status: "loading",
    error: "",
    searching: false,
    expanded: "",
    linking: false,
    neighbors: [],
    related: [],
  })

  const [query, setQuery] = createSignal("")
  const [filter, setFilter] = createSignal<Filter>("all")

  const location = () => ({ directory: props.session.directory })
  const searching = () => store.results !== undefined

  const load = () =>
    props.session.server.client
      .rpc(Memory.Definition)
      .overview({}, { location: location(), signal: controller.signal })
      .then(
        (next) => {
          if (controller.signal.aborted) return
          setStore({ status: "ready", overview: next, error: "" })
        },
        (cause: unknown) => {
          if (controller.signal.aborted) return
          setStore({ status: "error", error: reason(cause) })
        },
      )

  // The routed session's graph: the snapshot, then every write the server reports. It runs again
  // when another session is routed, the session moves, or its server reconnects.
  createKeyed(
    () => (props.session.server.connected ? props.session.server.id + "\u0000" + props.session.directory : undefined),
    () => {
      setStore({ status: "loading", results: undefined, expanded: "" })

      const seen = new AbortController()
      onCleanup(() => seen.abort())
      const rpc = props.session.server.client.rpc(Memory.Definition)
      onCleanup(
        rpc.events.on(
          "changed",
          () => void load(),
          { signal: seen.signal },
        ),
      )

      void load()
    },
  )

  const runSearch = () => {
    const text = query().trim()

    if (text.length === 0) {
      setStore({ results: undefined, searching: false })

      return
    }

    setStore({ searching: true, expanded: "" })

    props.session.server.client
      .rpc(Memory.Definition)
      .search({ query: text, limit: 24 }, { location: location(), signal: controller.signal })
      .then(
        (next) => {
          if (controller.signal.aborted) return
          setStore({ results: next, searching: false })
        },
        (cause: unknown) => {
          if (controller.signal.aborted) return
          setStore("searching", false)
          showToast({ variant: "error", title: ctx.t("error"), description: reason(cause) })
        },
      )
  }

  const clear = () => {
    setQuery("")
    setStore({ results: undefined, expanded: "" })
  }

  const forget = (node: Memory.Node) =>
    props.session.server.client
      .rpc(Memory.Definition)
      .forget({ id: node.id }, { location: location(), signal: controller.signal })
      .then(
        () => {
          if (controller.signal.aborted) return
          setStore("expanded", "")
          showToast({ variant: "success", title: ctx.t("forgotten") })
        },
        (cause: unknown) => {
          if (controller.signal.aborted) return
          showToast({ variant: "error", title: ctx.t("error"), description: reason(cause) })
        },
      )

  // Expanding a record reads its 1-hop neighborhood: which named things it links to, and the
  // records that mention it.
  const toggle = (node: Memory.Node) => {
    if (store.expanded === node.id) {
      setStore("expanded", "")

      return
    }

    setStore({ expanded: node.id, linking: true, neighbors: [], related: [] })

    props.session.server.client
      .rpc(Memory.Definition)
      .neighbors({ id: node.id }, { location: location(), signal: controller.signal })
      .then(
        (next) => {
          if (controller.signal.aborted || store.expanded !== node.id) return
          const byID = new Map([next.node, ...next.nodes].map((item) => [item.id, item]))
          const linked = new Set(next.edges.flatMap((edge) => [edge.source, edge.target]))
          setStore({
            linking: false,
            neighbors: next.edges.flatMap((edge) => {
              const from = byID.get(edge.source)
              const to = byID.get(edge.source === node.id ? edge.target : edge.source)

              return from && to ? [{ node: from, relation: edge.relation, via: to }] : []
            }),
            related: next.nodes.filter((item) => !linked.has(item.id)),
          })
        },
        (cause: unknown) => {
          if (controller.signal.aborted) return
          setStore("linking", false)
          showToast({ variant: "error", title: ctx.t("error"), description: reason(cause) })
        },
      )
  }

  const visible = (node: Memory.Node) => filter() === "all" || node.kind === filter()

  const rows = createMemo<Row[]>(() =>
    (searching() ? (store.results?.matches ?? []).map((match) => ({ node: match.node, via: match.via })) : (store.overview?.nodes ?? []).map((node) => ({ node }))).filter(
      (row) => visible(row.node),
    ),
  )

  const filters = createMemo(() => {
    const counts = store.overview?.counts

    return [
      { id: "all", label: ctx.t("filter.all"), count: searching() ? rows().length : counts ? counts.entities + counts.facts + counts.notes : undefined },
      { id: "entity", label: ctx.t("kind.entity"), count: counts?.entities },
      { id: "fact", label: ctx.t("kind.fact"), count: counts?.facts },
      { id: "note", label: ctx.t("kind.note"), count: counts?.notes },
    ] satisfies ReadonlyArray<{ id: Filter; label: string; count: number | undefined }>
  })

  const line = (node: Memory.Node) =>
    node.triple
      ? `${node.triple.subject} ${node.triple.predicate.replaceAll("_", " ")} ${node.triple.object}`
      : node.title

  const meta = (node: Memory.Node) => {
    const age = relative(ctx, Date.now() - node.timeUpdated)

    return [
      `${ctx.t("confidence.title")} ${Math.round(node.confidence * 100)}%`,
      `${ctx.t("importance.title")} ${Math.round(node.importance * 100)}%`,
      age,
    ].join(" · ")
  }

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base">
      <div class="shrink-0 px-3 pt-2 pb-1.5">
        <div class="flex items-center gap-1.5 rounded-md border-[0.5px] border-v2-border-border-muted px-2 py-1">
          <input
            type="text"
            spellcheck={false}
            autocomplete="off"
            aria-label={ctx.t("search.placeholder")}
            placeholder={ctx.t("search.placeholder")}
            value={query()}
            class="min-w-0 flex-1 bg-transparent text-12-regular text-v2-text-text-base outline-none"
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              event.stopPropagation()

              if (event.key === "Enter") runSearch()

              if (event.key === "Escape") clear()
            }}
          />
          <Show when={query().length > 0}>
            <Button size="small" variant="ghost-muted" onClick={clear} aria-label={ctx.t("search.clear")}>
              ×
            </Button>
          </Show>
        </div>
        <div class="mt-1.5 flex items-center gap-1 overflow-x-auto" data-scrollable>
          <For each={filters()}>
            {(item) => (
              <button
                type="button"
                aria-pressed={filter() === item.id}
                classList={{
                  "shrink-0 rounded-full border-[0.5px] px-2 py-0.5 text-[10px] font-medium tracking-wide transition-colors": true,
                  "border-v2-border-border-base text-v2-text-text-base": filter() === item.id,
                  "border-v2-border-border-muted text-v2-text-text-muted hover:text-v2-text-text-base": filter() !== item.id,
                }}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
                <Show when={item.count !== undefined && item.id !== "all"}>
                  <span class="ms-1 text-v2-text-text-muted">{item.count}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto" data-scrollable>
        <Show when={store.status === "loading"}>
          <div class="flex items-center gap-2 px-3 py-2 text-12-regular text-v2-text-text-muted">
            <Spinner class="size-3" /> {ctx.t("loading")}
          </div>
        </Show>
        <Show when={store.status === "error"}>
          <div class="flex flex-col gap-2 px-3 py-2">
            <span class="text-12-regular text-v2-state-fg-danger">{store.error || ctx.t("error")}</span>
            <Button size="small" variant="ghost" onClick={() => void load()}>
              {ctx.t("retry")}
            </Button>
          </div>
        </Show>
        <Show when={store.status === "ready" && rows().length === 0 && !store.searching}>
          <div class="px-3 py-2">
            <div class="text-12-regular text-v2-text-text-base">
              {searching() ? ctx.t("empty.search") : ctx.t("empty")}
            </div>
            <Show when={!searching()}>
              <div class="mt-1 text-12-regular text-v2-text-text-muted">{ctx.t("empty.hint")}</div>
            </Show>
          </div>
        </Show>
        <For each={rows()}>
          {(row) => (
            <div class="group border-b-[0.5px] border-v2-border-border-muted/60 last:border-b-0">
              <button
                type="button"
                class="flex w-full items-start gap-2 px-3 py-1.5 text-start transition-colors hover:bg-v2-background-bg-overlay/40"
                aria-expanded={store.expanded === row.node.id}
                onClick={() => toggle(row.node)}
              >
                <span class="mt-1 size-1.5 shrink-0 rounded-full bg-v2-text-text-muted/70" />
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="flex items-baseline gap-1.5">
                    <span class="shrink-0 text-[10px] font-medium uppercase tracking-wide text-v2-text-text-muted">
                      {ctx.t(`kind.${row.node.kind}`)}
                    </span>
                    <Show when={row.node.status === "superseded"}>
                      <span class="shrink-0 text-[10px] text-v2-text-text-muted">{ctx.t("superseded")}</span>
                    </Show>
                    <Show when={row.via !== undefined}>
                      <span class="shrink-0 ms-auto text-[10px] text-v2-text-text-muted">{ctx.t(`via.${row.via}`)}</span>
                    </Show>
                  </span>
                  <span
                    class={
                      store.expanded === row.node.id
                        ? "min-w-0 flex-1 text-12-regular leading-[var(--line-height-compact)] text-v2-text-text-base"
                        : "line-clamp-2 min-w-0 flex-1 text-12-regular leading-[var(--line-height-compact)] text-v2-text-text-base"
                    }
                  >
                    {line(row.node)}
                  </span>
                  <Show when={store.expanded === row.node.id && row.node.text}>
                    <span class="min-w-0 flex-1 pt-0.5 whitespace-pre-wrap text-12-regular leading-[var(--line-height-compact)] text-v2-text-text-muted">
                      {row.node.text}
                    </span>
                  </Show>
                </span>
              </button>
              <div class="flex items-center gap-1 px-3 pb-1.5">
                <Show when={store.expanded === row.node.id}>
                  <span class="min-w-0 flex-1 truncate text-[10px] text-v2-text-text-muted">{meta(row.node)}</span>
                </Show>
                <span class="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <Button
                    size="small"
                    variant="ghost-muted"
                    icon="outline-trash"
                    aria-label={ctx.t("forget")}
                    title={`${ctx.t("confidence.title")}: ${row.node.confidence.toFixed(2)} · ${ctx.t("importance.title")}: ${row.node.importance.toFixed(2)}`}
                    onClick={() => forget(row.node)}
                  />
                </span>
              </div>
              <Show when={store.expanded === row.node.id}>
                <div class="px-3 pb-2">
                  <div class="ms-2 border-s-[0.5px] border-v2-border-border-muted ps-3 py-1">
                    <Show when={store.linking}>
                      <Spinner class="size-3 text-v2-text-text-muted" />
                    </Show>
                    <Show when={!store.linking && store.neighbors.length > 0}>
                      <div class="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-v2-text-text-muted">
                        {ctx.t("links")}
                      </div>
                    </Show>
                    <For each={store.neighbors}>
                      {(link) => (
                        <div class="flex flex-wrap items-baseline gap-x-1.5 text-12-regular leading-[var(--line-height-compact)]">
                          <span class="text-v2-text-text-base">{line(link.node)}</span>
                          <span class="text-v2-text-text-muted">{link.relation.replaceAll("_", " ")}</span>
                          <span class="text-v2-text-text-base">{line(link.via)}</span>
                        </div>
                      )}
                    </For>
                    <Show when={store.related.length > 0}>
                      <div class="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-v2-text-text-muted">
                        {ctx.t("related")}
                      </div>
                      <For each={store.related}>
                        {(other) => <div class="text-12-regular text-v2-text-text-muted">{line(other)}</div>}
                      </For>
                    </Show>
                  </div>
                </div>
              </Show>
            </div>
          )}
        </For>
        <Show when={searching() && (store.results?.related.length ?? 0) > 0}>
          <div class="px-3 pt-2 text-[10px] font-medium uppercase tracking-wide text-v2-text-text-muted">
            {ctx.t("related")}
          </div>
          <For each={(store.results?.related ?? []).filter(visible)}>
            {(other) => (
              <div class="flex items-start gap-2 px-3 py-1">
                <span class="mt-1 size-1.5 shrink-0 rounded-full bg-v2-text-text-muted/40" />
                <span class="min-w-0 flex-1 text-12-regular text-v2-text-text-muted">{line(other)}</span>
              </div>
            )}
          </For>
        </Show>
        <Show when={store.searching}>
          <div class="flex items-center gap-2 px-3 py-2 text-12-regular text-v2-text-text-muted">
            <Spinner class="size-3" /> {ctx.t("loading")}
          </div>
        </Show>
      </div>
    </div>
  )
}

function relative(ctx: { t: (key: string) => string; plural: (key: string, count: number) => string }, age: number) {
  const minutes = Math.floor(age / 60_000)

  if (minutes < 1) return ctx.t("age.now")

  if (minutes < 60) return ctx.plural("age.minutes", minutes)

  const hours = Math.floor(minutes / 60)

  if (hours < 24) return ctx.plural("age.hours", hours)

  return ctx.plural("age.days", Math.floor(hours / 24))
}

function reason(cause: unknown) {
  if (cause instanceof Error) return cause.message

  return String(cause)
}
