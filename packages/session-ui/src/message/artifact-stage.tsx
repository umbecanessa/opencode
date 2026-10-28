import { createMemo, createSignal, For, onCleanup, onMount } from "solid-js"
import { useI18n } from "@opencode/ui/context/i18n"
import "./artifact-stage.css"

export type ArtifactViewport = "desktop" | "tablet" | "mobile"

export const VIEWPORTS: ArtifactViewport[] = ["desktop", "tablet", "mobile"]

const SIZES: Record<Exclude<ArtifactViewport, "desktop">, { width: number; height: number }> = {
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
}

const PRINT_MESSAGE = "opencode:artifact-print"

// Only the parent window may trigger printing. The frame is sandboxed without same-origin, so a
// message is the only way in; print() itself needs the frame's allow-modals.
const BRIDGE = `<script>addEventListener("message",function(e){if(e.source===parent&&e.data&&e.data.type===${JSON.stringify(PRINT_MESSAGE)})print()})</script>`

export const ARTIFACT_SANDBOX = "allow-scripts allow-downloads allow-modals allow-popups allow-forms"

/** Appends the print bridge; browsers move trailing content after `</html>` into the body. */
export function artifactSrcdoc(content: string) {
  return content + BRIDGE
}

export function printArtifact(frame: HTMLIFrameElement | undefined) {
  frame?.contentWindow?.postMessage({ type: PRINT_MESSAGE }, "*")
}

export function saveArtifact(content: string, name: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/html" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `${slug(name) || "artifact"}.html`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// Set by the app host where the platform renders HTML offscreen (desktop). Absent members
// hide or degrade the matching export action.
export type ArtifactSavers = {
  pdf?: (html: string, defaultPath: string) => Promise<boolean>
  png?: (html: string, defaultPath: string, width: number, height: number) => Promise<boolean>
  zip?: (html: string, defaultPath: string) => Promise<boolean>
}

let savers: ArtifactSavers = {}

export function registerArtifactSavers(next: ArtifactSavers) {
  savers = next
}

/** True where native exports exist; UI hides desktop-only actions otherwise. */
export function artifactNativeExport() {
  return !!(savers.pdf || savers.png || savers.zip)
}

/** PNG export sizes per viewport; desktop uses a standard widescreen viewport. */
export function artifactPngSize(viewport: ArtifactViewport) {
  if (viewport === "desktop") return { width: 1440, height: 900 }

  return SIZES[viewport]
}

/**
 * Saves the artifact as a PDF: the native save dialog on desktop, the browser print sheet
 * (which offers "Save as PDF") elsewhere. False only when the desktop user cancelled.
 */
export async function saveArtifactPdf(content: string, name: string, frame?: HTMLIFrameElement) {
  if (savers.pdf) return savers.pdf(content, `${slug(name) || "artifact"}.pdf`)

  if (frame) {
    printArtifact(frame)

    return true
  }

  // No mounted preview (code mode): print through a throwaway frame with the same sandbox.
  // window.print stays callable cross-origin, and the sandbox's allow-modals lets it through.
  const clone = document.createElement("iframe")
  clone.setAttribute("sandbox", ARTIFACT_SANDBOX)
  clone.setAttribute("aria-hidden", "true")
  clone.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none"
  clone.srcdoc = artifactSrcdoc(content)
  document.body.append(clone)
  clone.contentWindow?.print()
  setTimeout(() => clone.remove(), 60_000)

  return true
}

export function saveArtifactPng(content: string, name: string, viewport: ArtifactViewport) {
  const size = artifactPngSize(viewport)

  if (!savers.png) return Promise.resolve(false)

  return savers.png(content, `${slug(name) || "artifact"}.png`, size.width, size.height)
}

export function saveArtifactZip(content: string, name: string) {
  if (!savers.zip) return Promise.resolve(false)

  return savers.zip(content, `${slug(name) || "artifact"}.zip`)
}

/**
 * Sandboxed preview frame. Desktop fills the stage; tablet and mobile render at device size and
 * scale down to fit both the stage width and `maxHeight`.
 */
export function ArtifactStage(props: {
  content: string
  title: string
  viewport: ArtifactViewport
  /** Fixed stage height in pixels; omitted, the stage fills its container. */
  height?: number
  ref?: (frame: HTMLIFrameElement) => void
}) {
  let stage: HTMLDivElement | undefined
  const [box, setBox] = createSignal({ width: 0, height: 0 })

  onMount(() => {
    if (!stage) return

    const measure = () => setBox({ width: stage?.clientWidth ?? 0, height: stage?.clientHeight ?? 0 })
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    measure()
    onCleanup(() => observer.disconnect())
  })

  const device = createMemo(() => (props.viewport === "desktop" ? undefined : SIZES[props.viewport]))

  const scale = createMemo(() => {
    const size = device()
    const height = props.height ?? box().height

    if (!size || box().width === 0 || height === 0) return 1

    return Math.min(1, (box().width - 32) / size.width, (height - 32) / size.height)
  })

  const srcdoc = createMemo(() => artifactSrcdoc(props.content))

  return (
    <div
      ref={stage}
      data-component="artifact-stage"
      data-viewport={props.viewport}
      style={{ height: props.height === undefined ? "100%" : `${props.height}px` }}
    >
      <div
        data-slot="artifact-stage-device"
        style={
          device()
            ? {
                width: `${device()!.width * scale()}px`,
                height: `${device()!.height * scale()}px`,
              }
            : undefined
        }
      >
        <iframe
          ref={(frame) => props.ref?.(frame)}
          data-slot="artifact-stage-frame"
          srcdoc={srcdoc()}
          sandbox={ARTIFACT_SANDBOX}
          referrerPolicy="no-referrer"
          title={props.title}
          style={
            device()
              ? {
                  width: `${device()!.width}px`,
                  height: `${device()!.height}px`,
                  transform: `scale(${scale()})`,
                }
              : undefined
          }
        />
      </div>
    </div>
  )
}

export function ViewportToggle(props: {
  value: ArtifactViewport
  onChange: (viewport: ArtifactViewport) => void
}) {
  const i18n = useI18n()

  const labels = {
    desktop: "ui.artifact.viewport.desktop",
    tablet: "ui.artifact.viewport.tablet",
    mobile: "ui.artifact.viewport.mobile",
  } as const

  const label = (viewport: ArtifactViewport) => i18n.t(labels[viewport])

  return (
    <div data-slot="artifact-segmented" role="radiogroup" aria-label={i18n.t("ui.artifact.viewport")}>
      <For each={VIEWPORTS}>
        {(viewport) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.value === viewport}
            data-active={props.value === viewport ? "true" : undefined}
            onClick={() => props.onChange(viewport)}
          >
            {label(viewport)}
          </button>
        )}
      </For>
    </div>
  )
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
}
