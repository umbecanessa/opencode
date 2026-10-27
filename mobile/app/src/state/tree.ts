import type { Session } from "../api/types"

export type Family = { session: Session; children: Session[]; latest: number }

// Subagents nest under a parent from the same page; a child whose parent is not loaded stands alone.
export const nestSessions = (sessions: Session[]): Family[] => {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const children = new Map<string, Session[]>()
  const roots = sessions.filter((s) => {
    if (!s.parentID || !byId.has(s.parentID)) return true
    children.set(s.parentID, [...(children.get(s.parentID) ?? []), s])
    return false
  })
  return roots
    .map((session) => {
      const kids = (children.get(session.id) ?? []).sort((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0))
      const latest = Math.max(session.time.updated ?? 0, ...kids.map((k) => k.time.updated ?? 0))
      return { session, children: kids, latest }
    })
    .sort((a, b) => b.latest - a.latest)
}
