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
  parentID?: string
  projectID: string
  location: { directory: string }
  title: string
  agent?: string
  model?: string
  cost: number
  tokens: { input: number; output: number; reasoning: number }
  outcome?: unknown
  time: { created: number; updated: number; archived?: number | null; idle?: number; viewed?: number }
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
  save?: string[]
  message?: string
  host: HostID
}

export type PermissionDecision = "once" | "always" | "reject"

// Attachment handed to POST prompt; uri is a data: URL with the base64 payload.
export type PromptFile = { uri: string; name?: string }

export type FormValue = string | number | boolean | string[]
export type FormField = {
  key: string; type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external"
  title?: string; description?: string; required?: boolean; hidden?: boolean; placeholder?: string; url?: string
  default?: FormValue; custom?: boolean
  options?: { value: string; label: string; description?: string }[]
  when?: { key: string; op: "eq" | "neq"; value: string | number | boolean }[]
}
export type SessionForm = { id: string; sessionID: string; title: string; fields: FormField[]; host: HostID }

export type SessionEvent = {
  host: HostID
  type: string
  data: Record<string, unknown>
}

export type PendingPermission = { request: PermissionRequest; decision: string }
