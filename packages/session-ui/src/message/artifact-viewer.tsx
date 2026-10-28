import { createMemo, createSignal, For, Show } from "solid-js"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { useI18n } from "@opencode/ui/context/i18n"
import { artifactVersion, registerArtifact, sessionArtifacts, type RegisteredArtifact } from "./artifact-registry"
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

/** Full-size artifact view with the Session's artifact gallery. */
export function ArtifactViewer(props: { session: string; initial: RegisteredArtifact; viewport: ArtifactViewport }) {
  const i18n = useI18n()
  const list = createMemo(() => sessionArtifacts(props.session))
  const [selected, setSelected] = createSignal(props.initial.key)
  const [viewport, setViewport] = createSignal(props.viewport)
  const current = createMemo(() => list().find((item) => item.key === selected()) ?? props.initial)
  const height = Math.max(360, Math.round(window.innerHeight * 0.72))
  let frame: HTMLIFrameElement | undefined

  const name = (entry: RegisteredArtifact) => {
    const title = entry.title || entry.identifier || i18n.t("ui.artifact.untitled")
    const version = artifactVersion(list(), entry)

    return version === undefined ? title : `${title} · ${i18n.t("ui.artifact.version", { version })}`
  }

  // Saving an edit registers a later version; the gallery is reactive, so it appears and is
  // selected straight away while the original stays in the list.
  const applyEdit = (html: string) => {
    const key = `${current().key}#edit-${Date.now()}`
    registerArtifact(props.session, { ...current(), key, content: html, created: Date.now() })
    setSelected(key)
  }

  return (
    <Dialog size="x-large" class="artifact-viewer-dialog">
      <DialogHeader>
        <DialogTitleGroup title={name(current())} />
      </DialogHeader>
      <DialogBody>
        <div data-component="artifact-viewer" data-gallery={list().length > 1 ? "true" : undefined}>
          <Show when={list().length > 1}>
            <nav data-slot="artifact-viewer-gallery" aria-label={i18n.t("ui.artifact.gallery")}>
              <span data-slot="artifact-viewer-gallery-title">{i18n.t("ui.artifact.gallery")}</span>
              <For each={list()}>
                {(entry) => (
                  <button
                    type="button"
                    data-active={entry.key === selected() ? "true" : undefined}
                    aria-current={entry.key === selected() ? "true" : undefined}
                    onClick={() => setSelected(entry.key)}
                  >
                    {name(entry)}
                  </button>
                )}
              </For>
            </nav>
          </Show>
          <div data-slot="artifact-viewer-main">
            <div data-slot="artifact-viewer-toolbar">
              <ViewportToggle value={viewport()} onChange={setViewport} />
              <div data-slot="artifact-viewer-actions">
                <button type="button" onClick={() => saveArtifact(current().content, name(current()))}>
                  {i18n.t("ui.artifact.save")}
                </button>
                <button type="button" onClick={() => void saveArtifactPdf(current().content, name(current()), frame)}>
                  {i18n.t("ui.artifact.savePdf")}
                </button>
                <Show when={artifactNativeExport()}>
                  <button type="button" onClick={() => void saveArtifactPng(current().content, name(current()), viewport())}>
                    {i18n.t("ui.artifact.savePng")}
                  </button>
                  <button type="button" onClick={() => void saveArtifactZip(current().content, name(current()))}>
                    {i18n.t("ui.artifact.exportZip")}
                  </button>
                </Show>
              </div>
            </div>
            <ArtifactStage
              content={current().content}
              title={name(current())}
              viewport={viewport()}
              height={height}
              editable
              onPatch={applyEdit}
              ref={(element) => (frame = element)}
            />
          </div>
        </div>
      </DialogBody>
    </Dialog>
  )
}
