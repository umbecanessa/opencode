export type HostID = string

export type Host = {
  id: HostID
  name: string
  origin: string
  pairedAt: string
}

export type Project = {
  id: string
  name: string
  canonical: string
  host: HostID
}

export type Session = {
  id: string
  projectID: string
  location: { directory: string }
  title: string
  agent?: string
  model?: string
  cost: number
  tokens: { input: number; output: number; reasoning: number }
  outcome?: unknown
  time: { created: number; updated: number; archived?: number | null }
  host: HostID
}

export type MessagePage = {
  data: unknown[]
  cursor: { previous: string | null; next: string | null }
  host: HostID
  sessionID: string
}

export type FileEntry = {
  path: string
  type: "file" | "directory"
}

export type FileContent = {
  text: string
  truncated: boolean
  size: number
}

export type PermissionRequest = {
  id: string
  sessionID: string
  action: string
  resources: string[]
  message?: string
  host: HostID
}

export type SessionEvent = {
  host: HostID
  type: string
  data: Record<string, unknown>
}

export type PendingPermission = { request: PermissionRequest; decision: string }
