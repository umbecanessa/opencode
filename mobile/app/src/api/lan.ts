import AsyncStorage from "@react-native-async-storage/async-storage"
import { NativeModules } from "react-native"

// Same-Wi-Fi escape hatch: when the tailnet path to a host stalls (stale peer discovery, dead DERP),
// the phone and the host are often reachable directly over the LAN. The opencode service listens on
// 0.0.0.0:28894, so we sweep the phone's own /24 for a machine that accepts this host's pairing
// token — a 200 from /api/project proves the identity, not just an open port.

const cacheKey = (hostID: string) => `lanOrigin:${hostID}`

// The phone's Wi-Fi address, via React Native's built-in Networking module (en0 on iOS).
const phoneIP = () => {
  const table = NativeModules.Networking?.getConstants?.()?.ipAddresses as Record<string, string> | undefined
  const ip = table?.en0 ?? Object.values(table ?? {})[0]
  return ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : undefined
}

// Only worth sweeping when the configured origin is a tailnet address (100.64.0.0/10 or .ts.net);
// a LAN origin needs no discovery, and public origins are not our machines.
const tailnetOrigin = (origin: string) => {
  try {
    const url = new URL(origin)
    return /^100\./.test(url.hostname) || url.hostname.endsWith(".ts.net")
  } catch {
    return false
  }
}

const probe = async (base: string, token: string) => {
  try {
    const res = await fetch(`${base}/api/project`, {
      headers: { accept: "application/json", authorization: `Basic ${btoa(`opencode:${token}`)}` },
      signal: AbortSignal.timeout(2_000),
    })
    return res.status === 200
  } catch {
    return false
  }
}

export const cachedLanOrigin = async (hostID: string) => AsyncStorage.getItem(cacheKey(hostID))

export const forgetLanOrigin = (hostID: string) => AsyncStorage.removeItem(cacheKey(hostID))

// Returns a LAN origin that authenticates against this host's token, or undefined. Cached in
// AsyncStorage so a verified machine is instant on the next launch, and re-swept after any change.
export const findLanOrigin = async (hostID: string, origin: string, token: string): Promise<string | undefined> => {
  if (!tailnetOrigin(origin)) return undefined
  const port = new URL(origin).port || "28894"
  const remembered = await cachedLanOrigin(hostID).catch(() => null)
  if (remembered && (await probe(remembered, token))) return remembered
  const ip = phoneIP()
  if (!ip) return undefined
  const base = ip.split(".").slice(0, 3).join(".")
  const candidates = Array.from({ length: 254 }, (_, i) => `http://${base}.${i + 1}:${port}`).filter((c) => !c.includes(`://${ip}:`))
  for (let i = 0; i < candidates.length; i += 24) {
    const hits = await Promise.all(candidates.slice(i, i + 24).map((c) => probe(c, token).then((ok) => (ok ? c : undefined))))
    const win = hits.find(Boolean)
    if (win) {
      void AsyncStorage.setItem(cacheKey(hostID), win).catch(() => {})
      return win
    }
  }
  return undefined
}
