import electron from "electron"

/**
 * Partitions this process has loaded. Chromium keeps a loaded partition's storage context - and
 * the databases inside it - alive until the app exits, no matter whether any page still uses it,
 * so once a partition is here its files must not be deleted for the rest of the process's life:
 * an rm that races an open database is exactly the half-deleted state Chromium 152 loops on,
 * re-posting its open task with no backoff until the main process runs out of memory.
 * Every `session.fromPartition` of a browser partition goes through this file so the set stays
 * complete; deleters consult it and defer to the next run when a partition is already loaded.
 */
const loaded = new Set<string>()

export function partitionSession(partition: string) {
  loaded.add(partition)

  return electron.session.fromPartition(partition)
}

export function partitionIsLoaded(partition: string) {
  return loaded.has(partition)
}
