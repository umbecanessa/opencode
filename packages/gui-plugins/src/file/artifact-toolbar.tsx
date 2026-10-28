import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { SegmentedControl, SegmentedControlItem } from "@opencode/ui/segmented-control"
import { Tooltip } from "@opencode/ui/tooltip"
import { showToast } from "@opencode/ui/toast"
import { artifactKind } from "@opencode/util/artifact"
import { getFilename } from "@opencode/util/path"
import type { ArtifactViewport } from "@opencode/session-ui/artifact-stage"
import { usePlugin, type MountedSession, type SessionScreen } from "@opencode/plugin/gui"
import { current, useShared } from "./context"
import { OpenInAppMenuItemsV2, useOpenInApp } from "./open-in-app"
import { resolveOpenInAppPath, workspaceFileUrl } from "./path"

export function ArtifactToolbar(props: {
  session: MountedSession
  screen: SessionScreen
  path: string
  text?: string
  mode: "preview" | "source"
  onModeChange?: (mode: "preview" | "source") => void
  meta: string[]
  html: boolean
  /** HTML preview extras the fork adds: click-to-edit, device viewports, and native exports. */
  editing?: () => boolean
  onEdit?: () => void
  viewport?: () => ArtifactViewport
  onViewportChange?: (viewport: ArtifactViewport) => void
  onSavePdf?: () => void
  onSavePng?: () => void
  onSaveZip?: () => void
}) {
  const ctx = usePlugin()
  const shared = useShared()
  const [store, setStore] = createStore({ open: false })
  const path = () => resolveOpenInAppPath(props.screen.file.root, props.path)
  const kind = () => artifactKind(props.path)

  const apps = useOpenInApp({
    get session() {
      return props.session
    },
    path,
  })

  const browser = () => {
    if (!props.html) return
    const pane = current(shared.browser())

    return pane?.canOpen(props.session, props.path) ? pane : undefined
  }

  const modeLabel = () => ctx.t(props.mode === "preview" ? "view.viewSource" : "view.viewPreview")
  const toggleMode = () => props.onModeChange?.(props.mode === "preview" ? "source" : "preview")

  const failed = () => {
    if (ctx.signal.aborted) return
    showToast({ variant: "error", title: ctx.t("common.requestFailed") })
  }

  const copy = (text: string) => {
    void ctx.system
      .copy(text)
      .then(() => {
        if (ctx.signal.aborted) return
        showToast({ variant: "success", title: ctx.t("common.copied") })
      })
      .catch(failed)
  }

  return (
    <div data-slot="artifact-toolbar" data-menu-open={store.open || undefined}>
      <div data-slot="artifact-filename" title={props.path}>
        <bdi>{getFilename(props.path)}</bdi>
      </div>
      <div data-slot="artifact-toolbar-trailing">
        <div data-slot="artifact-metadata">
          <For each={props.meta}>
            {(item, index) => (
              <>
                <Show when={index() > 0}>
                  <span aria-hidden>·</span>
                </Show>
                <bdi class="truncate" title={item}>
                  {item}
                </bdi>
              </>
            )}
          </For>
        </div>
        <div data-slot="artifact-toolbar-actions">
          <Show when={props.viewport !== undefined && props.onViewportChange}>
            <SegmentedControl
              value={props.viewport!()}
              onChange={(value) => {
                if (value === "desktop" || value === "tablet" || value === "mobile") props.onViewportChange!(value)
              }}
            >
              <SegmentedControlItem value="desktop">{ctx.t("view.viewport.desktop")}</SegmentedControlItem>
              <SegmentedControlItem value="tablet">{ctx.t("view.viewport.tablet")}</SegmentedControlItem>
              <SegmentedControlItem value="mobile">{ctx.t("view.viewport.mobile")}</SegmentedControlItem>
            </SegmentedControl>
          </Show>
          <Show when={props.onEdit && !props.editing?.()}>
            <Tooltip value={ctx.t("view.edit")}>
              <IconButton
                variant="ghost-muted"
                size="large"
                aria-label={ctx.t("view.edit")}
                onClick={() => props.onEdit?.()}
                icon={<Icon name="edit" size="normal" />}
              />
            </Tooltip>
          </Show>
          <Show when={props.onModeChange}>
            <Tooltip value={modeLabel()}>
              <IconButton
                data-slot="artifact-mode-toggle"
                variant="ghost-muted"
                size="large"
                aria-label={modeLabel()}
                onClick={toggleMode}
                icon={<Icon name={props.mode === "preview" ? "outline-code-brackets" : "outline-eye"} size="normal" />}
              />
            </Tooltip>
          </Show>
          <Show when={props.text !== undefined}>
            <Tooltip value={ctx.t("view.copyContent")}>
              <IconButton
                variant="ghost-muted"
                size="large"
                aria-label={ctx.t("view.copyContent")}
                onClick={() => copy(props.text ?? "")}
                icon={<Icon name="outline-copy" size="normal" />}
              />
            </Tooltip>
          </Show>
          <Menu gutter={0} placement="bottom-end" open={store.open} onOpenChange={(open) => setStore("open", open)}>
            <Menu.Trigger
              as={IconButton}
              variant="ghost-muted"
              size="large"
              aria-label={ctx.t("view.actions")}
              icon={<Icon name="outline-dots" size="normal" />}
            />
            <Menu.Portal>
              <Menu.Content class="artifact-actions-menu">
                <Show when={props.onSavePdf}>
                  <Menu.Item onSelect={() => props.onSavePdf?.()}>{ctx.t("view.savePdf")}</Menu.Item>
                </Show>
                <Show when={props.onSavePng}>
                  <Menu.Item onSelect={() => props.onSavePng?.()}>{ctx.t("view.savePng")}</Menu.Item>
                </Show>
                <Show when={props.onSaveZip}>
                  <Menu.Item onSelect={() => props.onSaveZip?.()}>{ctx.t("view.exportZip")}</Menu.Item>
                </Show>
                <Show when={props.text !== undefined}>
                  <Menu.Item
                    onSelect={() => {
                      void ctx.system.save({ name: getFilename(props.path), content: props.text ?? "" }).catch(failed)
                    }}
                  >
                    {ctx.t("view.download")}
                  </Menu.Item>
                </Show>
                <Show when={props.onModeChange}>
                  <Menu.Item onSelect={toggleMode}>{modeLabel()}</Menu.Item>
                </Show>
                <Show when={browser()}>
                  {(pane) => (
                    <Menu.Item
                      onSelect={() => pane().open(props.session, workspaceFileUrl(props.screen.file.root, props.path))}
                    >
                      {ctx.t("view.openInBrowser")}
                    </Menu.Item>
                  )}
                </Show>
                <Show when={apps.canOpen()}>
                  <Menu.Item onSelect={() => apps.openPath("finder", path(), true)} disabled={apps.opening()}>
                    {ctx.t("view.reveal", { app: apps.options()[0].label })}
                  </Menu.Item>
                </Show>
                <Menu.Item onSelect={() => copy(path())}>{ctx.t("open.copyPath")}</Menu.Item>
                <Show when={apps.canOpen() && kind() !== "audio" && kind() !== "video"}>
                  <Menu.Sub>
                    <Menu.SubTrigger disabled={apps.opening()}>{ctx.t("open.in")}</Menu.SubTrigger>
                    <Menu.Portal>
                      <Menu.SubContent class="open-in-app-v2-menu">
                        <OpenInAppMenuItemsV2 state={apps} copyPath={false} close={() => setStore("open", false)} />
                      </Menu.SubContent>
                    </Menu.Portal>
                  </Menu.Sub>
                </Show>
              </Menu.Content>
            </Menu.Portal>
          </Menu>
        </div>
      </div>
    </div>
  )
}
