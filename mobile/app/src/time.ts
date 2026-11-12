// Compact relative age for list gutters and meta rows: now / 12m / 3h / 5d / 2w / 8mo.
export const relTime = (ms: number) => {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`
  if (s < 30 * 86_400) return `${Math.floor(s / (7 * 86_400))}w`
  return `${Math.floor(s / (30 * 86_400))}mo`
}

// Same ages phrased as "3d ago" — but never the nonsensical "now ago".
export const agoText = (ms: number) => {
  const r = relTime(ms)
  return r === "now" ? "now" : `${r} ago`
}
