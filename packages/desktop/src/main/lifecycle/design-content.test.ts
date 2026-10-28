import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DesignContent } from "./design-content"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "design-content-"))
  roots.push(root)
  const source = path.join(root, "bundle")
  const target = path.join(root, "config")
  await write(path.join(source, "skills", "web-prototype", "SKILL.md"), "bundled v2")
  await write(path.join(source, "skills", "web-prototype", "assets", "template.html"), "<html></html>")

  return { source, target }
}

async function write(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
}

const skill = (target: string) => path.join(target, "skills", "web-prototype")

describe("DesignContent.seed", () => {
  const cases = [
    {
      name: "absent directory is installed",
      prepare: async () => {},
      bucket: "installed",
      skill: "bundled v2",
    },
    {
      name: "previously bundled directory with stale content is refreshed",
      prepare: async (target: string) => {
        await write(path.join(skill(target), "SKILL.md"), "bundled v1")
        await write(path.join(skill(target), "removed.md"), "gone after refresh")
        await write(path.join(skill(target), ".opencode-bundled"), "old-hash")
      },
      bucket: "updated",
      skill: "bundled v2",
    },
    {
      name: "user-owned directory without the marker is never touched",
      prepare: async (target: string) => {
        await write(path.join(skill(target), "SKILL.md"), "my edits")
      },
      bucket: "kept",
      skill: "my edits",
    },
  ] as const

  for (const item of cases) {
    test(item.name, async () => {
      const { source, target } = await fixture()
      await item.prepare(target)

      const result = await DesignContent.seed(source, target)

      expect(result[item.bucket]).toEqual(["skills/web-prototype"])
      expect(await readFile(path.join(skill(target), "SKILL.md"), "utf8")).toBe(item.skill)

      if (item.bucket === "kept") return

      expect(await readFile(path.join(skill(target), "assets", "template.html"), "utf8")).toBe("<html></html>")
      expect(await readFile(path.join(skill(target), "removed.md"), "utf8").catch(() => "absent")).toBe("absent")
    })
  }

  test("a second run with unchanged content does nothing", async () => {
    const { source, target } = await fixture()
    await DesignContent.seed(source, target)

    expect(await DesignContent.seed(source, target)).toEqual({ installed: [], updated: [], kept: [] })
  })

  test("a missing bundle directory seeds nothing", async () => {
    const { target } = await fixture()

    expect(await DesignContent.seed(path.join(target, "missing"), target)).toEqual({
      installed: [],
      updated: [],
      kept: [],
    })
  })
})
