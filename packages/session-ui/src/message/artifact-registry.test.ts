import { describe, expect, test } from "bun:test"
import { artifactVersion, registerArtifact, sessionArtifacts, type RegisteredArtifact } from "./artifact-registry"

const entry = (key: string, created: number, identifier = "page", content = key): RegisteredArtifact => ({
  key,
  identifier,
  title: "Page",
  type: "text/html",
  content,
  created,
  index: 0,
})

describe("artifact registry", () => {
  test("lists a Session's artifacts chronologically regardless of render order", () => {
    registerArtifact("ses_order", entry("late", 300))
    registerArtifact("ses_order", entry("early", 100))
    registerArtifact("ses_order", entry("middle", 200))

    expect(sessionArtifacts("ses_order").map((item) => item.key)).toEqual(["early", "middle", "late"])
  })

  test("re-rendering a block updates it in place instead of adding a version", () => {
    registerArtifact("ses_update", entry("a", 100, "page", "first"))
    registerArtifact("ses_update", entry("a", 100, "page", "fixed"))

    const list = sessionArtifacts("ses_update")
    expect(list.length).toBe(1)
    expect(list[0]!.content).toBe("fixed")
  })

  test("re-emitted identifiers become versions; unique and unnamed ones stay unversioned", () => {
    registerArtifact("ses_versions", entry("v1", 100, "landing"))
    registerArtifact("ses_versions", entry("other", 150, "pricing"))
    registerArtifact("ses_versions", entry("v2", 200, "landing"))
    registerArtifact("ses_versions", entry("anon", 250, ""))
    const list = sessionArtifacts("ses_versions")
    const version = (key: string) => artifactVersion(list, list.find((item) => item.key === key)!)

    expect([version("v1"), version("v2"), version("other"), version("anon")]).toEqual([1, 2, undefined, undefined])
  })

  test("Sessions do not share galleries", () => {
    registerArtifact("ses_a", entry("only-a", 100))

    expect(sessionArtifacts("ses_b")).toEqual([])
  })
})
