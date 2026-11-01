import electron from "electron"
import path from "node:path"

/**
 * Partitions this process has loaded. Chromium keeps a loaded partition's storage context - and
 * the databases inside it - alive until the app exits, no matter whether any page still uses it,
 * so once a partition is here its files must not be deleted for the rest of the process's life:
 * an rm that races an open database is exactly the half-deleted state Chromium 152 loops on,
 * re-posting its open task with no backoff until the main process runs out of memory.
 * Every mount of a browser partition goes through this file so the set stays complete; deleters
 * consult it and defer to the next run when a partition is already loaded.
 */
const loaded = new Set<string>()

/** The name a partition's files live under: its `persist:` name with the prefix stripped. */
function partitionKey(partition: string) {
  return partition.replace(/^persist:/, "")
}

/**
 * The directory a browser partition's storage lives in. Browser partitions are mounted by path,
 * never by `persist:` name: Chromium's storage service keys a context's session-storage control
 * by partition directory, while Electron keys its contexts by (name, in-memory) - so any second
 * context that resolves the same name through another rule (an off-the-record clone, a content
 * layer config) shares the directory with a different key, and the pair shuts down each other's
 * storage tens of thousands of times a second until the main process runs out of memory
 * (crbug.com/396030877). Persistent named partitions always land under `Partitions/<name>`, but
 * a fromPath directory lives outside it, where no named-partition rule can compute its path, so
 * the two-owner collision is impossible by construction.
 */
export function partitionDirectory(partition: string) {
  return path.join(electron.app.getPath("userData"), "browser-data", partitionKey(partition))
}

export function partitionSession(partition: string) {
  loaded.add(partitionKey(partition))

  return electron.session.fromPath(partitionDirectory(partition))
}

export function partitionIsLoaded(partition: string) {
  return loaded.has(partitionKey(partition))
}
