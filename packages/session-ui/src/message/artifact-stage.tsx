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
