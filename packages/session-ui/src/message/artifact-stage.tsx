import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
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
const BRIDGE = `<script id="__op">addEventListener("message",function(e){if(e.source===parent&&e.data&&e.data.type===${JSON.stringify(PRINT_MESSAGE)})print()})</script>`

const EDIT_MESSAGE = "opencode:artifact-edit"

// Click-to-edit runtime injected into the preview. It stays inert until the parent turns it on:
// hover/select outlines, element patches (text, href, inline styles), and clean serialization
// that strips both injected scripts before handing the document back.
const EDIT_BRIDGE = `<script id="__oe">(function(){var EDIT=${JSON.stringify(EDIT_MESSAGE)};var on=false;var sel=null;
function send(m){m.type=EDIT;parent.postMessage(m,"*")}
function pathOf(el){var p=[];for(var n=el;n&&n.nodeType===1;n=n.parentElement){var i=1,s=n;while((s=s.previousElementSibling))i++;p.unshift(n.tagName.toLowerCase()+":nth-child("+i+")");if(n===document.documentElement)break}return p.join(">")}
function ownText(el){var t="";var has=false;for(var n=el.firstChild;n;n=n.nextSibling)if(n.nodeType===3){has=true;t+=n.data}return has?t:undefined}
function hex(v){var m=/rgba?\\((\\d+)[, ]+(\\d+)[, ]+(\\d+)/.exec(v);if(!m)return null;return "#"+[m[1],m[2],m[3]].map(function(x){return (+x).toString(16).padStart(2,"0")}).join("")}
function infoOf(el){if(!el||!el.isConnected)return null;var cs=getComputedStyle(el);var a=el.closest("a");return{path:pathOf(el),tag:el.tagName.toLowerCase(),text:ownText(el),href:a?a.getAttribute("href"):null,color:hex(cs.color),background:hex(cs.backgroundColor),size:Math.round(parseFloat(cs.fontSize)||16)}}
function pick(el){if(sel)sel.removeAttribute("data-oe");sel=el&&el!==document.documentElement&&el!==document.body?el:null;if(sel)sel.setAttribute("data-oe","sel");send({kind:"pick",info:infoOf(sel)})}
function over(e){if(!sel||e.target===sel)return;document.querySelectorAll('[data-oe="hover"]').forEach(function(x){if(x!==sel)x.removeAttribute("data-oe")});if(e.target!==sel&&e.target!==document.documentElement)e.target.setAttribute("data-oe","hover")}
function onClick(e){e.preventDefault();e.stopPropagation();pick(e.target===document?document.body:e.target)}
function onKey(e){if(e.key==="Escape")pick(null)}
function applyPatch(p){if(!sel)return;if(p.text!==undefined){var first=null;for(var n=sel.firstChild;n;){var next=n.nextSibling;if(n.nodeType===3){if(!first){n.data=p.text;first=n}else sel.removeChild(n)}n=next}if(!first)sel.insertBefore(document.createTextNode(p.text),sel.firstChild)}
if(p.href!==undefined){var a=sel.closest("a")||sel;if(a)a.setAttribute("href",p.href)}
if(p.color!==undefined)sel.style.color=p.color;
if(p.background!==undefined)sel.style.backgroundColor=p.background;
if(p.size!==undefined)sel.style.fontSize=p.size+"px";
send({kind:"pick",info:infoOf(sel)})}
function serialize(){var d=document.documentElement.cloneNode(true);["#__oe","#__op","#__oes"].forEach(function(s){var j=d.querySelector(s);if(j)j.remove()});d.querySelectorAll("[data-oe]").forEach(function(e){e.removeAttribute("data-oe")});return"<!DOCTYPE html>\\n"+d.outerHTML}
addEventListener("message",function(e){if(e.source!==parent||!e.data||e.data.type!==EDIT)return;var m=e.data;
if(m.cmd==="on"&&!on){on=true;if(!document.getElementById("__oes")){var s=document.createElement("style");s.id="__oes";s.textContent='[data-oe="hover"]{outline:2px solid #7ab8ff;outline-offset:1px;}[data-oe="sel"]{outline:2px solid #3b82f6;outline-offset:1px;}';(document.head||document.documentElement).appendChild(s)}document.addEventListener("click",onClick,true);document.addEventListener("mouseover",over,true);document.addEventListener("keydown",onKey,true);send({kind:"ready"})}
if(m.cmd==="off"&&on){on=false;document.removeEventListener("click",onClick,true);document.removeEventListener("mouseover",over,true);document.removeEventListener("keydown",onKey,true);pick(null)}
if(m.cmd==="patch")applyPatch(m.patch||{});
if(m.cmd==="reset"&&sel)pick(sel);
if(m.cmd==="html")send({kind:"html",id:m.id,html:serialize()})}
})();</script>`

export const ARTIFACT_SANDBOX = "allow-scripts allow-downloads allow-modals allow-popups allow-forms"

/** The element under the click-to-edit selector; undefined until the frame reports one. */
export type ArtifactEditSelection = {
  path: string
  tag: string
  /** Direct text content when the element owns text nodes; undefined for structural elements. */
  text?: string
  href?: string | null
  color?: string | null
  background?: string | null
  size?: number
}

/** One click-to-edit correction applied to the selected element. */
export type ArtifactEditPatch = {
  text?: string
  href?: string
  color?: string
  background?: string
  size?: number
}

/** Parent-to-frame edit commands, on top of the EDIT_MESSAGE discriminator. */
type EditCommand = { cmd: "on" } | { cmd: "off" } | { cmd: "patch"; patch: ArtifactEditPatch } | { cmd: "html"; id: string }

/** Frame-to-parent reports: a new selection, readiness, or the serialized document. */
type EditReport = { type?: string; kind?: string; info?: ArtifactEditSelection | null; id?: string; html?: string }

/** Appends the print and edit bridges; browsers move trailing content after `</html>` into the body. */
export function artifactSrcdoc(content: string) {
  return content + BRIDGE + EDIT_BRIDGE
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
 * When `editable`, a floating toggle turns the frame into a click-to-edit surface; `onPatch`
 * receives the edited document when the user saves, or is omitted for read-only stages.
 */
export function ArtifactStage(props: {
  content: string
  title: string
  viewport: ArtifactViewport
  /** Fixed stage height in pixels; omitted, the stage fills its container. */
  height?: number
  ref?: (frame: HTMLIFrameElement) => void
  editable?: boolean
  onPatch?: (html: string) => void
}) {
  const i18n = useI18n()
  let stage: HTMLDivElement | undefined
  const [box, setBox] = createSignal({ width: 0, height: 0 })
  const [editing, setEditing] = createSignal(false)
  const [selection, setSelection] = createSignal<ArtifactEditSelection | null>(null)
  const [nonce, setNonce] = createSignal(0)
  let stageFrame: HTMLIFrameElement | undefined
  const htmlRequests = new Map<string, (html: string) => void>()
  let htmlSeq = 0

  const sendFrame = (message: EditCommand) =>
    stageFrame?.contentWindow?.postMessage({ type: EDIT_MESSAGE, ...message }, "*")

  const setEditMode = (next: boolean) => {
    setEditing(next)

    if (!next) setSelection(null)

    sendFrame({ cmd: next ? "on" : "off" })
  }

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

  const srcdoc = createMemo(() => artifactSrcdoc(props.content) + (nonce() ? `<!--oe-reset-${nonce()}-->` : ""))

  onMount(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== stageFrame?.contentWindow) return

      // SAFETY: postMessage payloads are untyped JSON; every field is optional and each use
      // first matches on kind, so a foreign message can only read as undefined fields.
      const data = event.data as EditReport | null

      if (!data || data.type !== EDIT_MESSAGE) return

      if (data.kind === "pick") setSelection(data.info ?? null)

      if (data.kind === "html" && data.id) {
        const resolve = htmlRequests.get(data.id)
        htmlRequests.delete(data.id)
        resolve?.(data.html ?? "")
      }
    }

    window.addEventListener("message", onMessage)
    onCleanup(() => window.removeEventListener("message", onMessage))
  })

  const saveEdit = () => {
    const id = String(++htmlSeq)
    const timeout = setTimeout(() => htmlRequests.delete(id), 5000)

    new Promise<string>((resolve) => htmlRequests.set(id, resolve)).then((html) => {
      clearTimeout(timeout)

      if (!html) return

      setEditMode(false)
      props.onPatch?.(html)
    })

    sendFrame({ cmd: "html", id })
  }

  const discardEdit = () => {
    setEditMode(false)
    setNonce((n) => n + 1)
  }

  const patch = (edit: ArtifactEditPatch) => sendFrame({ cmd: "patch", patch: edit })

  return (
    <div
      ref={stage}
      data-component="artifact-stage"
      data-viewport={props.viewport}
      data-editing={editing() ? "true" : undefined}
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
          ref={(el) => {
            stageFrame = el
            el.addEventListener("load", () => {
              if (editing()) sendFrame({ cmd: "on" })
            })
            props.ref?.(el)
          }}
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
      <Show when={props.editable}>
        <Show when={!editing()}>
          <button type="button" data-slot="artifact-edit-toggle" onClick={() => setEditMode(true)}>
            {i18n.t("ui.artifact.edit")}
          </button>
        </Show>
        <Show when={editing()}>
          <div data-slot="artifact-edit-bar" onKeyDown={(e) => e.key === "Escape" && setEditMode(false)}>
            <Show when={selection()}>
              <div data-slot="artifact-edit-fields">
                <Show when={selection()!.text !== undefined}>
                  <label>
                    {i18n.t("ui.artifact.editText")}
                    <textarea
                      rows={2}
                      value={selection()!.text ?? ""}
                      onInput={(e) => patch({ text: e.currentTarget.value })}
                    />
                  </label>
                </Show>
                <Show when={selection()!.tag === "a" || (selection()!.href !== undefined && selection()!.href !== null)}>
                  <label>
                    {i18n.t("ui.artifact.editLink")}
                    <input
                      type="url"
                      value={selection()!.href ?? ""}
                      onInput={(e) => patch({ href: e.currentTarget.value })}
                    />
                  </label>
                </Show>
                <label>
                  {i18n.t("ui.artifact.editColor")}
                  <input
                    type="color"
                    value={selection()!.color ?? "#000000"}
                    onInput={(e) => patch({ color: e.currentTarget.value })}
                  />
                </label>
                <label>
                  {i18n.t("ui.artifact.editBackground")}
                  <input
                    type="color"
                    value={selection()!.background ?? "#ffffff"}
                    onInput={(e) => patch({ background: e.currentTarget.value })}
                  />
                </label>
                <label>
                  {i18n.t("ui.artifact.editFontSize")}
                  <input
                    type="number"
                    min={6}
                    max={400}
                    value={selection()!.size ?? 16}
                    onInput={(e) => patch({ size: Number(e.currentTarget.value) || undefined })}
                  />
                </label>
              </div>
            </Show>
            <Show when={!selection()}>
              <span data-slot="artifact-edit-hint">{i18n.t("ui.artifact.editHint")}</span>
            </Show>
            <div data-slot="artifact-edit-actions">
              <button type="button" data-active="true" onClick={saveEdit}>
                {i18n.t("ui.artifact.editSave")}
              </button>
              <button type="button" onClick={discardEdit}>
                {i18n.t("ui.artifact.editDiscard")}
              </button>
              <button type="button" onClick={() => setEditMode(false)}>
                {i18n.t("ui.artifact.editClose")}
              </button>
            </div>
          </div>
        </Show>
      </Show>
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
