import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { useI18n } from "@opencode/ui/context/i18n"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import type { ArtifactSegment } from "../components/artifact-split"
import "./artifact-card.css"

type Artifact = Extract<ArtifactSegment, { kind: "artifact" }>

/** Chat card for an `<artifact>` block: live code while generating, sandboxed preview when done. */
export function ArtifactCard(props: { artifact: Artifact }) {
  const i18n = useI18n()
  const artifact = () => props.artifact

  const previewable = createMemo(() => {
    const type = artifact().type

    return (type === "" || /text\/html|svg/i.test(type)) && artifact().state !== "streaming"
  })

  const [mode, setMode] = createSignal<"code" | "preview">("code")
  const [mountPreview, setMountPreview] = createSignal(false)
  createEffect(() => {
    if (artifact().state === "done" && previewable() && mode() === "preview") setMountPreview(true)
  })

  const [copied, setCopied] = createSignal(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(artifact().content)
    } catch {
      const textarea = document.createElement("textarea")
      textarea.value = artifact().content
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

  const title = () => artifact().title || artifact().identifier || i18n.t("ui.artifact.untitled")

  return (
    <div
      data-component="artifact-card"
      data-state={artifact().state}
      data-mode={mode()}
    >
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
          <Show when={previewable()}>
            <div data-slot="artifact-card-toggle" role="tablist">
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
          </Show>
          <button
            type="button"
            data-slot="artifact-card-copy"
            onClick={copy}
            aria-label={i18n.t("ui.artifact.copy")}
            title={i18n.t("ui.artifact.copy")}
          >
            <Icon name={copied() ? "check" : "outline-copy"} size="small" />
          </button>
        </div>
      </div>
      <Show when={artifact().state === "truncated"}>
        <div data-slot="artifact-card-note">{i18n.t("ui.artifact.truncated")}</div>
      </Show>
      <div data-slot="artifact-card-body">
        <Show when={mountPreview()}>
          <iframe
            data-slot="artifact-card-frame"
            srcdoc={artifact().content}
            sandbox="allow-scripts allow-downloads"
            referrerPolicy="no-referrer"
            title={title()}
            hidden={mode() !== "preview"}
          />
        </Show>
        <Show when={!(mode() === "preview" && mountPreview())}>
          <pre data-slot="artifact-card-code">
            <code>{artifact().content}</code>
          </pre>
        </Show>
      </div>
    </div>
  )
}
