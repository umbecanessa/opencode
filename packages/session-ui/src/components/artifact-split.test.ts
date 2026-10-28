import { describe, expect, test } from "bun:test"
import { splitArtifacts, hasArtifacts } from "./artifact-split"

const artifacts = (text: string, streaming = false) =>
  splitArtifacts(text, streaming).filter((segment) => segment.kind === "artifact")

const markdown = (text: string, streaming = false) =>
  splitArtifacts(text, streaming)
    .filter((segment) => segment.kind === "markdown")
    .map((segment) => (segment.kind === "markdown" ? segment.text : ""))
    .join("")

describe("splitArtifacts", () => {
  test("passes text without artifacts through unchanged", () => {
    const text = "Hello **world**, nothing here."
    expect(splitArtifacts(text, false)).toEqual([{ kind: "markdown", text }])
    expect(hasArtifacts(splitArtifacts(text, false))).toBe(false)
  })

  test("extracts a complete artifact with attributes and surrounding markdown", () => {
    const text = [
      "Here you go:",
      '<artifact identifier="landing" type="text/html" title="Landing Page">',
      "<!doctype html><html><body>hi</body></html>",
      "</artifact>",
      "Done!",
    ].join("\n")

    const segments = splitArtifacts(text, false)
    expect(hasArtifacts(segments)).toBe(true)
    expect(segments[0]).toEqual({ kind: "markdown", text: "Here you go:\n" })
    expect(segments[1]).toEqual({
      kind: "artifact",
      identifier: "landing",
      type: "text/html",
      title: "Landing Page",
      content: "\n<!doctype html><html><body>hi</body></html>\n",
      state: "done",
    })
    expect(segments[2]).toEqual({ kind: "markdown", text: "\nDone!" })
  })

  test("keeps two sequential artifacts in one message", () => {
    const text =
      '<artifact type="text/html">A</artifact>\nbetween\n<artifact type="text/html">B</artifact>'

    const found = artifacts(text)
    expect(found.length).toBe(2)
    expect(found[0]!.kind === "artifact" && found[0]!.content).toBe("A")
    expect(found[1]!.kind === "artifact" && found[1]!.content).toBe("B")
    expect(markdown(text)).toContain("between")
  })

  test("requires whitespace after <artifact", () => {
    expect(artifacts("<artifactual note about tags>")).toEqual([])
    expect(artifacts("<artifact>x</artifact>")).toEqual([])
  })

  test("ignores tags inside fenced code blocks", () => {
    const text = [
      "```html",
      '<artifact type="text/html">',
      "ignored",
      "</artifact>",
      "```",
    ].join("\n")

    expect(artifacts(text)).toEqual([])
    expect(markdown(text)).toContain("<artifact")
  })

  test("ignores tags inside an unclosed fence (streaming code block)", () => {
    const text = "```html\n<artifact type=\"text/html\">\n<div>half streamed fence"
    expect(artifacts(text, true)).toEqual([])
  })

  test("ignores tags inside inline code spans", () => {
    const text = "write `<artifact type=\"text/html\">` tags around output"
    expect(artifacts(text, true)).toEqual([])
  })

  test("streaming: unclosed artifact is live with its partial body", () => {
    const text = 'Working on it:\n<artifact type="text/html" title="Live">\n<h1>hel'
    const found = artifacts(text, true)
    expect(found.length).toBe(1)
    expect(found[0]!.kind === "artifact" && found[0]!.state).toBe("streaming")
    expect(found[0]!.kind === "artifact" && found[0]!.content).toBe("\n<h1>hel")
    expect(found[0]!.kind === "artifact" && found[0]!.title).toBe("Live")
  })

  test("streaming: opener tag split mid-attribute still yields a live artifact", () => {
    const text = 'Done thinking.\n<artifact type="text/htm'
    const found = artifacts(text, true)
    expect(found.length).toBe(1)
    expect(found[0]!.kind === "artifact" && found[0]!.state).toBe("streaming")
    expect(found[0]!.kind === "artifact" && found[0]!.content).toBe("")
    expect(markdown(text, true)).toBe("Done thinking.\n")
  })

  test("streaming: partial opener tail does not flash as prose", () => {
    const text = "Here is the page <artif"
    expect(markdown(text, true)).toBe("Here is the page ")
    expect(artifacts(text, true)).toEqual([])
  })

  test("finished message: truncated textual artifact is marked, media one stays literal", () => {
    const truncated = '<artifact type="text/html">\n<div>never closed'
    expect(artifacts(truncated, false)[0]!.kind === "artifact" && artifacts(truncated, false)[0]!.state).toBe(
      "truncated",
    )

    const media = '<artifact type="image/png">\nnot html'
    expect(artifacts(media, false)).toEqual([])
    expect(markdown(media)).toContain("<artifact")
  })

  test("artifact body bytes are verbatim", () => {
    const body = "&amp; <script>let x = 1</script> 'quoted > angle' "
    const text = `<artifact type="text/html">${body}</artifact>`
    expect(artifacts(text)[0]!.kind === "artifact" && artifacts(text)[0]!.content).toBe(body)
  })

  test("attribute values may contain > inside quotes", () => {
    const text = '<artifact type="text/html" title="a > b">x</artifact>'
    const found = artifacts(text)
    expect(found.length).toBe(1)
    expect(found[0]!.kind === "artifact" && found[0]!.title).toBe("a > b")
  })
})
