import { lazy, onCleanup, Suspense } from "solid-js"
import type { Plugin } from "@opencode/plugin/gui"
import { SettingsPage } from "@opencode/plugin/gui"
import { BuiltinPanel, onIdle, type BuiltinPanelTab } from "@opencode/plugin/gui/builtin"
import type definition from "./index"

/**
 * The project knowledge graph as a pinned side tab: its current records, a search over them, and the
 * neighborhood of each record. The server's memory plugin owns the graph and serves it over its RPC;
 * every write it makes publishes `changed`, which refreshes this view.
 */
const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const MemoryPanel = lazy(() => import("./panel"))
  const MemorySettings = lazy(() => import("./settings"))
  // Compile the tab while the app idles, so the first open renders at once.
  onCleanup(onIdle(() => void Promise.all([MemoryPanel.preload(), MemorySettings.preload()])))

  // The app's own server, whose ref is already authenticated in this window. Embedding settings
  // are machine-wide, so the page works with no session routed.
  const local = () =>
    ctx.servers
      .list()
      .map((id) => ctx.servers.get(id))
      .find((server) => server?.builtin)

  ctx.add(SettingsPage, {
    id: "memory",
    icon: "brain",
    get title() {
      return ctx.t("title")
    },
    get entries() {
      return [
        { id: "memory-embeddings", title: ctx.t("settings.title"), keywords: "embedding vectors semantic local model search memory" },
      ]
    },
    render: () => (
      <Suspense fallback={<div class="min-h-16" />}>
        <MemorySettings server={local} />
      </Suspense>
    ),
  })

  const tab: BuiltinPanelTab = {
    id: "main",
    get title() {
      return ctx.t("title")
    },
    pinned: true,
  }

  ctx.add(BuiltinPanel, {
    id: "main",
    region: "side",
    mobile: {
      get title() {
        return ctx.t("mobile.title")
      },
      order: 50,
      kind: "menu",
      icon: "outline-brain",
    },
    // A pinned tab stays listed whatever the session's stored layout holds.
    list: () => [tab],
    render: (props) => (
      <Suspense fallback={<div class="min-h-0 flex-1" />}>
        <MemoryPanel session={props.session} />
      </Suspense>
    ),
  })
}

export default setup
