import { Show, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { ContextMenu } from "@opencode/ui/context-menu"
import { usePlatform } from "@/runtime/platform/platform"
import { useLanguage } from "@/runtime/i18n/language"
import { useLayout } from "@/shell/state/layout"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"
import { showToast } from "@/shell/notifications/toast"

// Right-click actions for file paths shown in chat (links, inline code, file references).
// The menu is disabled unless the pointer went down on a path-like element, so plain
// right-clicks keep their native behavior.
export function FilePathMenu(props: ParentProps) {
  const platform = usePlatform()
  const language = useLanguage()
  const layout = useLayout()
  const global = useGlobal()
  const [state, setState] = createStore({ path: "" })
  const local = () => {
    const route = layout.route()
    if (route.type !== "session") return false
    const connection = global.servers.list().find((item) => ServerConnection.key(item) === route.server)
    return !!connection && ServerConnection.local(connection)
  }
  const fail = () => showToast({ title: language.t("common.requestFailed"), description: language.t("sidebar.fileActionFailed") })
  return <ContextMenu>
    <ContextMenu.Trigger disabled={!state.path} as="div" class="flex min-h-0 min-w-0 flex-1 flex-col self-stretch" onPointerDown={(event: PointerEvent) => {
      if (event.button !== 2) return
      const target = event.target
      if (!(target instanceof Element)) return setState("path", "")
      const element = target.closest("a, code, [data-file-path]")
      if (!element) return setState("path", "")
      const raw = element.getAttribute("data-file-path") ?? element.getAttribute("href") ?? element.textContent?.trim() ?? ""
      const path = raw.replace(/^file:\/\/\//, "").replace(/^\/([A-Za-z]:[\\/])/, "$1")
      setState("path", /^(?:[A-Za-z]:[\\/]|\/[^/])/.test(path) && !/[\r\n]/.test(path) ? path : "")
    }}>
      {props.children}
    </ContextMenu.Trigger>
    <ContextMenu.Portal><ContextMenu.Content>
      <ContextMenu.Item onSelect={() => { navigator.clipboard.writeText(state.path).catch(fail) }}>{language.t("sidebar.copyPath")}</ContextMenu.Item>
      <Show when={local() && platform.openPath}><ContextMenu.Item onSelect={() => { platform.openPath?.(state.path).catch(fail) }}>{language.t("sidebar.openFile")}</ContextMenu.Item></Show>
      <Show when={local() && platform.revealPath}><ContextMenu.Item onSelect={() => { platform.revealPath?.(state.path).then((found) => { if (!found) fail() }).catch(fail) }}>{language.t("sidebar.revealFile")}</ContextMenu.Item></Show>
    </ContextMenu.Content></ContextMenu.Portal>
  </ContextMenu>
}
