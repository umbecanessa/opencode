/**
 * Splits assistant text into markdown segments and `<artifact>` blocks.
 *
 * Protocol (aligned with OpenDesign's artifact convention):
 * `<artifact identifier="..." type="text/html" title="...">BODY</artifact>`.
 * An opener counts only when `<artifact` is followed by whitespace, which
 * keeps prose like "an artifactual note" from triggering, and openers inside
 * fenced code blocks or inline code spans are literal text.
 *
 * Pure string function recomputed per delta: the chat store exposes the whole
 * text as a signal, so unlike a stream-fed state machine this can rescan.
 */

export type ArtifactSegment =
  | { kind: "markdown"; text: string }
  | {
      kind: "artifact"
      identifier: string
      type: string
      title: string
      content: string
      state: "streaming" | "done" | "truncated"
    }

const OPEN = "<artifact"

const CLOSE = "</artifact>"

const TEXTUAL = /html|text\//i

export function splitArtifacts(text: string, streaming: boolean): ArtifactSegment[] {
  const skip = computeSkipRanges(text)
  const segments: ArtifactSegment[] = []
  let cursor = 0
  let pos = 0

  while (pos < text.length) {
    const open = findOpen(text, pos, skip)

    if (open === -1) break

    const attrsEnd = findTagEnd(text, open)

    if (attrsEnd === -1) {
      // opener tag still arriving; hold it out of the markdown flow while live
      if (!streaming) break
      pushMarkdown(segments, text.slice(cursor, open))
      segments.push({ kind: "artifact", identifier: "", type: "", title: "", content: "", state: "streaming" })

      return segments
    }

    const attrs = parseAttrs(text.slice(open + OPEN.length, attrsEnd))
    const close = text.indexOf(CLOSE, attrsEnd + 1)

    if (close === -1) {
      const body = text.slice(attrsEnd + 1)

      if (!streaming && !isTextual(attrs)) break
      pushMarkdown(segments, text.slice(cursor, open))
      segments.push({
        kind: "artifact",
        ...attrs,
        content: body,
        state: streaming ? "streaming" : "truncated",
      })

      return segments
    }

    pushMarkdown(segments, text.slice(cursor, open))
    segments.push({
      kind: "artifact",
      ...attrs,
      content: text.slice(attrsEnd + 1, close),
      state: "done",
    })
    cursor = close + CLOSE.length
    pos = cursor
  }

  let tail = text.slice(cursor)

  if (streaming) tail = trimPartialOpenTail(tail)
  pushMarkdown(segments, tail)

  return segments
}

/** True when the segment list carries protocol content (otherwise passthrough). */
export function hasArtifacts(segments: ArtifactSegment[]) {
  return segments.some((segment) => segment.kind === "artifact")
}

function pushMarkdown(segments: ArtifactSegment[], text: string) {
  if (text.length > 0) segments.push({ kind: "markdown", text })
}

function isTextual(attrs: { type: string }) {
  return attrs.type === "" || TEXTUAL.test(attrs.type)
}

/** A trailing partial opener ("<art", "<artifac") must not flash as prose. */
function trimPartialOpenTail(text: string) {
  const start = Math.max(0, text.length - OPEN.length + 1)

  for (let i = start; i < text.length; i++) {
    const tail = text.slice(i)

    if (OPEN.startsWith(tail) && tail.startsWith("<")) return text.slice(0, i)
  }

  return text
}

function findOpen(text: string, from: number, skip: [number, number][]) {
  let pos = from

  for (;;) {
    const index = text.indexOf(OPEN, pos)

    if (index === -1) return -1
    const next = text.charAt(index + OPEN.length)

    if (/\s/.test(next) && !inRanges(skip, index)) return index
    pos = index + 1
  }
}

/** End of the opener tag: the `>` outside quoted attribute values. */
function findTagEnd(text: string, open: number) {
  let quote = ""

  for (let i = open + OPEN.length; i < text.length; i++) {
    const char = text[i]!

    if (quote) {
      if (char === quote) quote = ""
      continue
    }

    if (char === '"' || char === "'") quote = char

    if (char === ">") return i

    if (char === "<") return -1
  }

  return -1
}

function parseAttrs(raw: string) {
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  const attrs: Record<string, string> = {}
  let match = re.exec(raw)

  while (match !== null) {
    attrs[match[1]!] = match[2] ?? match[3] ?? ""
    match = re.exec(raw)
  }

  return {
    identifier: attrs["identifier"] ?? "",
    type: attrs["type"] ?? "",
    title: attrs["title"] ?? "",
  }
}

/** Fenced code blocks and inline code spans: protocol tags there are literal. */
function computeSkipRanges(text: string): [number, number][] {
  const ranges: [number, number][] = []
  let offset = 0
  let fence: string | undefined
  let fenceStart = 0

  for (const line of text.split("\n")) {
    const lineStart = offset
    const lineEnd = offset + line.length + 1
    offset = lineEnd

    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)

    if (fence) {
      const closing = marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length

      if (closing) {
        ranges.push([fenceStart, lineEnd])
        fence = undefined
      }

      continue
    }

    if (marker) {
      fence = marker[1]!
      fenceStart = lineStart
      continue
    }

    // inline code: pair backtick runs within the line (multi-line spans are rare
    // enough in prose that line-local pairing is an acceptable approximation)
    const runs = [...line.matchAll(/`+/g)]

    for (let i = 0; i + 1 < runs.length; i += 2) {
      const a = runs[i]!
      const b = runs[i + 1]!
      ranges.push([lineStart + a.index, lineStart + b.index + b[0]!.length])
    }

    if (runs.length % 2 === 1) ranges.push([lineStart + runs[runs.length - 1]!.index, lineEnd])
  }

  if (fence !== undefined) ranges.push([fenceStart, text.length + 1])

  return ranges
}

function inRanges(ranges: [number, number][], index: number) {
  return ranges.some(([start, end]) => index >= start && index < end)
}
