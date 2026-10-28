export * as DesignContent from "./design-content"

import { createHash } from "node:crypto"
import { cp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

// Bundled skills and brand kits ship as plain directories and land in the opencode config
// directory, where the service already discovers and watches skills. That is a filesystem
// contract with the service, so sqlite is not an option here.
const GROUPS = ["skills", "design-systems"] as const

const MARKER = ".opencode-bundled"

export type Result = {
  installed: string[]
  updated: string[]
  /** Directories without the marker: user-owned, never modified. */
  kept: string[]
}

/** Mirrors the service's config root: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. */
export function configDirectory() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode")
}

/**
 * Copies each bundled directory into `target` when absent and refreshes directories this
 * function installed earlier whose bundled content changed. A content hash in the marker file
 * decides staleness, so an updated bundle needs no version bump.
 */
export async function seed(source: string, target: string): Promise<Result> {
  const result: Result = { installed: [], updated: [], kept: [] }

  for (const group of GROUPS) {
    const names = await directories(path.join(source, group))

    for (const name of names) {
      const from = path.join(source, group, name)
      const to = path.join(target, group, name)
      const id = `${group}/${name}`
      const hash = await hashDirectory(from)
      const marker = await readFile(path.join(to, MARKER), "utf8").catch(() => undefined)
      const exists = marker !== undefined || (await stat(to).then(() => true, () => false))

      if (exists && marker === undefined) {
        result.kept.push(id)
        continue
      }

      if (marker?.trim() === hash) continue

      if (exists) await rm(to, { recursive: true, force: true })
      await cp(from, to, { recursive: true })
      await writeFile(path.join(to, MARKER), hash)
      const bucket = exists ? result.updated : result.installed
      bucket.push(id)
    }
  }

  return result
}

async function directories(root: string) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])

  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).toSorted()
}

async function hashDirectory(root: string) {
  const hash = createHash("sha256")
  const entries = await readdir(root, { recursive: true, withFileTypes: true })

  const files = entries
    .filter((entry) => entry.isFile() && entry.name !== MARKER)
    .map((entry) => path.join(entry.parentPath, entry.name))
    .toSorted()

  for (const file of files) {
    hash.update(path.relative(root, file).split(path.sep).join("/"))
    hash.update("\0")
    hash.update(await readFile(file))
    hash.update("\0")
  }

  return hash.digest("hex")
}
