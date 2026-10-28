import { createStore } from "solid-js/store"

/** A finished artifact seen in a Session, kept so the viewer can show the Session's gallery. */
export type RegisteredArtifact = {
  /** Unique per rendered block: text part ID plus segment index. */
  key: string
  identifier: string
  title: string
  type: string
  content: string
  /** Creation time of the message that carried the block, for chronological order. */
  created: number
  /** Position of the block inside its message. */
  index: number
}

// Cards register as they render. The timeline virtualizes rows, so the gallery holds what this
// window has rendered so far; it never drops entries when cards unmount.
const [store, setStore] = createStore<Record<string, RegisteredArtifact[]>>({})

export function registerArtifact(session: string, entry: RegisteredArtifact) {
  const list = store[session] ?? []
  const index = list.findIndex((item) => item.key === entry.key)

  if (index === -1) {
    setStore(session, [...list, entry])

    return
  }

  if (list[index]!.content === entry.content && list[index]!.title === entry.title) return
  setStore(session, index, entry)
}

export function sessionArtifacts(session: string) {
  return (store[session] ?? []).toSorted((a, b) => a.created - b.created || a.index - b.index)
}

/** 1-based version among artifacts that share an identifier; undefined when unversioned. */
export function artifactVersion(list: RegisteredArtifact[], entry: RegisteredArtifact) {
  if (!entry.identifier) return undefined
  const same = list.filter((item) => item.identifier === entry.identifier)

  if (same.length < 2) return undefined

  return same.findIndex((item) => item.key === entry.key) + 1
}
