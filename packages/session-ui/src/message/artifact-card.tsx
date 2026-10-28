import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { useDialog } from "@opencode/ui/context/dialog"
import { useI18n } from "@opencode/ui/context/i18n"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { useData } from "../context"
import type { ArtifactSegment } from "../components/artifact-split"
import { registerArtifact, type RegisteredArtifact } from "./artifact-registry"
import {
  ArtifactStage,
  artifactNativeExport,
  saveArtifact,
  saveArtifactPdf,
  saveArtifactPng,
  saveArtifactZip,
  ViewportToggle,
  type ArtifactViewport,
} from "./artifact-stage"
import { ArtifactViewer } from "./artifact-viewer"
import "./artifact-card.css"

type Artifact = Extract<ArtifactSegment, { kind: "artifact" }>

/** Chat card for an `<artifact>` block: live code while generating, sandboxed preview when done. */
export function ArtifactCard(props: { artifact: Artifact; artifactKey: string; created: number; index: number }) {
  const i18n = useI18n()
  const dialog = useDialog()
  const data = useData()
  const artifact = () => props.artifact
  const session = () => data.sessionID ?? ""

  const previewable = createMemo(() => {
    const type = artifact().type

    return (type === "" || /text\/html|svg/i.test(type)) && artifact().state !== "streaming"
  })

  const [mode, setMode] = createSignal<"code" | "preview">("code")
  const [viewport, setViewport] = createSignal<ArtifactViewport>("desktop")
  const [mountPreview, setMountPreview] = createSignal(false)
  const [edited, setEdited] = createSignal<string>()
  let frame: HTMLIFrameElement | undefined

  createEffect(() => {
    if (artifact().state === "done" && previewable() && mode() === "preview") setMountPreview(true)
  })

  const title = () => artifact().title || artifact().identifier || i18n.t("ui.artifact.untitled")
  const content = () => edited() ?? artifact().content

  const entry = createMemo<RegisteredArtifact>(() => ({
    key: props.artifactKey,
    identifier: artifact().identifier,
    title: artifact().title,
    type: artifact().type,
    content: content(),
    created: props.created,
    index: props.index,
  }))

  createEffect(() => {
    if (artifact().state === "done" && previewable()) registerArtifact(session(), entry())
  })

  // A saved edit becomes the card's artifact: the entry effect above re-registers it, so the
  // card, the viewer opened from it, and every export all show the patched document.
  const applyEdit = (html: string) => setEdited(html)

  const [copied, setCopied] = createSignal(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content())
    } catch {
      const textarea = document.createElement("textarea")
      textarea.value = content()
      textarea.setAttribute("readonly", "")
      textarea.style.position = "fixed"
      textarea.style.opacity = "0"
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand("copy")
      document.body.removeChild(textarea)
    }

    setCopied(true)
    const timeout = setTimeout(() => setCopied(false), 2000)
    onCleanup(() => clearTimeout(timeout))
  }

  const expand = () =>
    dialog.show(() => <ArtifactViewer session={session()} initial={entry()} viewport={viewport()} />)

  return (
    <div data-component="artifact-card" data-state={artifact().state} data-mode={mode()}>
      <div data-slot="artifact-card-header">
        <span data-slot="artifact-card-title">
          <Icon name="code-slash" size="small" />
          <span data-slot="artifact-card-name">{title()}</span>
        </span>
        <div data-slot="artifact-card-actions">
          <Show when={artifact().state === "streaming"}>
            <span data-slot="artifact-card-status">
              <TextShimmer text={i18n.t("ui.artifact.generating")} active />
            </span>
          </Show>
          <Show when={previewable() && mode() === "preview"}>
            <ViewportToggle value={viewport()} onChange={setViewport} />
          </Show>
          <Show when={previewable()}>
            <div data-slot="artifact-segmented" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode() === "preview"}
                data-active={mode() === "preview" ? "true" : undefined}
                onClick={() => setMode("preview")}
              >
                {i18n.t("ui.artifact.preview")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode() === "code"}
                data-active={mode() === "code" ? "true" : undefined}
                onClick={() => setMode("code")}
              >
                {i18n.t("ui.artifact.code")}
              </button>
            </div>
            <IconButton
              icon={<Icon name="expand" size="small" />}
              size="normal"
              variant="ghost-muted"
              onClick={expand}
              aria-label={i18n.t("ui.artifact.expand")}
              title={i18n.t("ui.artifact.expand")}
            />
          </Show>
          <Show
            when={previewable()}
            fallback={
              <IconButton
                icon={<Icon name={copied() ? "check" : "outline-copy"} size="small" />}
                size="normal"
                variant="ghost-muted"
                onClick={copy}
                aria-label={i18n.t("ui.artifact.copy")}
                title={i18n.t("ui.artifact.copy")}
              />
            }
          >
            <Menu gutter={4} modal={false} placement="bottom-end">
              <Menu.Trigger
                as={IconButton}
                icon={<Icon name={copied() ? "check" : "outline-dots"} size="small" />}
                size="normal"
                variant="ghost-muted"
                aria-label={i18n.t("ui.artifact.more")}
              />
              <Menu.Portal>
                <Menu.Content style={{ "min-width": "180px" }}>
                  <Menu.Item onSelect={() => saveArtifact(content(), title())}>
                    {i18n.t("ui.artifact.save")}
                  </Menu.Item>
                  <Menu.Item onSelect={() => void saveArtifactPdf(content(), title(), frame)}>
                    {i18n.t("ui.artifact.savePdf")}
                  </Menu.Item>
                  <Show when={artifactNativeExport()}>
                    <Menu.Item onSelect={() => void saveArtifactPng(content(), title(), viewport())}>
                      {i18n.t("ui.artifact.savePng")}
                    </Menu.Item>
                    <Menu.Item onSelect={() => void saveArtifactZip(content(), title())}>
                      {i18n.t("ui.artifact.exportZip")}
                    </Menu.Item>
                  </Show>
                  <Menu.Separator />
                  <Menu.Item onSelect={() => void copy()}>{i18n.t("ui.artifact.copy")}</Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu>
          </Show>
        </div>
      </div>
      <Show when={artifact().state === "truncated"}>
        <div data-slot="artifact-card-note">{i18n.t("ui.artifact.truncated")}</div>
      </Show>
      <div data-slot="artifact-card-body">
        <Show when={mountPreview()}>
          <div hidden={mode() !== "preview"}>
            <ArtifactStage
              content={content()}
              title={title()}
              viewport={viewport()}
              height={viewport() === "desktop" ? 480 : 560}
              editable={previewable()}
              onPatch={applyEdit}
              ref={(element) => (frame = element)}
            />
          </div>
        </Show>
        <Show when={!(mode() === "preview" && mountPreview())}>
          <pre data-slot="artifact-card-code">
            <code>{content()}</code>
          </pre>
        </Show>
      </div>
    </div>
  )
}
