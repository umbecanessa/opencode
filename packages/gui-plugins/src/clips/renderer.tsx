import { For, Show } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { FileIcon } from "@opencode/ui/file-icon"
import { getFilename } from "@opencode/util/path"
import { Panel, type Live, type PanelTab, type Plugin } from "@opencode/plugin/gui"
import { FileOpen } from "@opencode/plugin/gui/file"
import { ClipsTray } from "./contract"
import type Clips from "./index"

/** How many clips the tray keeps; pinning more drops the oldest. */
const LIMIT = 50

/** A provider's value while it is active; the row opens nothing otherwise. */
function current<T>(live: Live<T>) {
  return live.status === "active" ? live.value : undefined
}

/**
 * The clips tray: files pinned from anywhere, listed in a pinned side tab. Clips are live file references, so a row
 * previews its file through the file plugin and goes missing with it. A clip opens only while its own project is
 * routed; elsewhere it names the host it waits on.
 */
const setup: Plugin.Setup<typeof Clips> = (ctx) => {
  const fileOpen = ctx.use(FileOpen)

  const add: ClipsTray["add"] = (clip) => {
    ctx.stores.clips.update((draft) => {
      const existing = draft.items.find((item) => item.server === clip.server && item.path === clip.path)

      if (existing) draft.items.splice(draft.items.indexOf(existing), 1)
      draft.items.unshift({ ...clip, id: existing?.id ?? crypto.randomUUID(), time: Date.now() })
      draft.items.splice(LIMIT)
    })
  }

  const remove: ClipsTray["remove"] = (id) => {
    ctx.stores.clips.update((draft) => {
      const at = draft.items.findIndex((item) => item.id === id)

      if (at !== -1) draft.items.splice(at, 1)
    })
  }

  ctx.provide(ClipsTray, { add, remove })

  const tab: PanelTab = {
    id: "tray",
    get title() {
      return ctx.t("title")
    },
    label: () => (
      <div class="flex items-center gap-1.5">
        <Icon name="grid-plus" size="small" />
        <span>{ctx.t("title")}</span>
      </div>
    ),
    pinned: true,
    draggable: false,
    closable: false,
  }

  const tabs: PanelTab[] = [tab]

  ctx.add(Panel, {
    id: "tray",
    region: "side",
    mobile: {
      get title() {
        return ctx.t("title")
      },
      order: 30,
      kind: "menu",
      icon: "grid-plus",
    },
    list: () => tabs,
    render: (props) => (
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div class="min-h-0 flex-1 overflow-y-auto px-1 py-1" data-scrollable>
          <Show
            when={ctx.stores.clips.value.items.length > 0}
            fallback={<p class="px-3 py-2 text-12-regular text-v2-text-text-faint">{ctx.t("empty")}</p>}
          >
            <For each={ctx.stores.clips.value.items}>{(clip) => (
              <ClipRow clip={clip} here={() => clip.server === props.session.server.id && clip.directory === props.session.directory} host={() => ctx.servers.get(clip.server)?.name} open={() => current(fileOpen())?.open(props.session, clip.path)} remove={() => remove(clip.id)} label={ctx.t} />
            )}</For>
          </Show>
        </div>
      </div>
    ),
  })
}

function ClipRow(props: {
  clip: { server: string; directory: string; path: string }
  here: () => boolean
  host: () => string | undefined
  open: () => void
  remove: () => void
  label: (key: string) => string
}) {
  return (
    <div
      class="group flex min-h-9 min-w-0 items-center gap-1.5 rounded-md px-2 text-13-regular"
      classList={{ "cursor-pointer hover:bg-v2-background-bg-layer-02": props.here() }}
      title={props.here() ? props.clip.path : `${props.clip.directory} · ${props.host() ?? ""}`}
      onClick={() => {
        if (props.here()) props.open()
      }}
    >
      <FileIcon node={{ path: props.clip.path, type: "file" }} />
      <span class="min-w-0 flex-1 truncate">{getFilename(props.clip.path)}</span>
      <Show when={!props.here}>
        <span class="shrink-0 truncate text-12-regular text-v2-text-text-faint">{props.host() ?? props.label("unreachable")}</span>
      </Show>
      <button
        type="button"
        aria-label={props.label("remove")}
        class="shrink-0 rounded-md p-1 opacity-0 hover:bg-v2-background-bg-layer-02 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={(event) => {
          event.stopPropagation()
          props.remove()
        }}
      >
        <Icon name="close-small" size="small" />
      </button>
    </div>
  )
}

export default setup
