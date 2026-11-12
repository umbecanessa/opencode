import { lazy, onCleanup, Suspense } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { MenuItem, Plugin } from "@opencode/plugin/gui"
import { BuiltinPanel, onIdle, type BuiltinPanelTab } from "@opencode/plugin/gui/builtin"
import type definition from "./index"

/**
 * Durable project todos as a pinned side tab: plain open/done items per project, kept server-side and
 * shared by voice-note triage, the agent's todo tool, and this panel. The list spans every project,
 * the routed one first; adding files into the routed project.
 */
const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const TodosPanel = lazy(() => import("./panel"))
  // Compile the tab while the app idles, so the first open renders at once.
  onCleanup(onIdle(() => void TodosPanel.preload()))

  const tab: BuiltinPanelTab = {
    id: "main",
    get title() {
      return ctx.t("title")
    },
    label: () => (
      <div class="flex items-center gap-1.5">
        <Icon name="check" size="small" />
        <span>{ctx.t("title")}</span>
      </div>
    ),
    pinned: true,
  }

  // A stable array keeps the tab's trigger from remounting.
  const tabs: BuiltinPanelTab[] = [tab]

  // A launcher of the side panel's new tab view, after the terminal's card.
  ctx.add(MenuItem, (): MenuItem | undefined => {
    const session = ctx.sessions.current()

    if (!session) return undefined

    return {
      menu: "session.panel",
      id: "todos",
      title: ctx.t("title"),
      icon: "check",
      order: 45,
      run: () => ctx.layout.open("todos:main", session),
    }
  })

  ctx.add(BuiltinPanel, {
    id: "main",
    region: "side",
    mobile: {
      get title() {
        return ctx.t("title")
      },
      order: 40,
      kind: "menu",
      icon: "check",
    },
    // A pinned tab stays listed whatever the session's stored layout holds.
    list: () => tabs,
    render: (props) => (
      <Suspense fallback={<div class="min-h-0 flex-1" />}>
        <TodosPanel session={props.session} />
      </Suspense>
    ),
  })
}

export default setup
