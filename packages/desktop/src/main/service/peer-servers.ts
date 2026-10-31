export * as PeerServers from "./peer-servers"

import { Effect } from "effect"
import type { PluginEndpoint } from "../../shared/ipc-rpc/plugins"
import { SidecarCredentials } from "./sidecar-credentials"

/**
 * Pushes the app's remote server list into the sidecar's runtime peer-server
 * registry so the session tools can dispatch to the same SSH and WSL tunnels
 * the user sees. The list is retained here so a sidecar that becomes reachable
 * later — or reconnects with a new password — gets the current set without
 * waiting for a renderer to report it again.
 */
let reported: readonly PluginEndpoint[] = []

const publish = Effect.fn("PeerServers.publish")(function* () {
  const sidecar = SidecarCredentials.get()
  if (sidecar === undefined) return
  const servers = Object.fromEntries(
    reported.flatMap((entry) => {
      // The sidecar is never its own peer.
      if (URL.canParse(entry.url) && new URL(entry.url).origin === sidecar.url) return []
      return [[entry.id, { url: entry.url, ...(entry.password === undefined ? {} : { credential: entry.password }) }]]
    }),
  )
  const authorization = SidecarCredentials.authorization(sidecar, sidecar.url)

  // Best-effort: an unreachable or older sidecar simply keeps the tools local-only until the next report.
  yield* Effect
    .tryPromise(() =>
      fetch(`${sidecar.url}/api/experimental/peer-servers`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
        body: JSON.stringify({ servers }),
      }).then((response) => {
        if (!response.ok) throw new Error(`registration rejected (HTTP ${response.status})`)
      }),
    )
    .pipe(
      Effect.tapError((error) => Effect.logWarning("failed to register peer servers with the sidecar", { error })),
      Effect.ignore,
    )
})

/** Replaces the reported list and publishes it. */
export const configure = (servers: readonly PluginEndpoint[]) => {
  reported = servers
  return publish()
}

/** Re-publishes the retained list, e.g. after the sidecar URL or password changed. */
export const republish = publish
