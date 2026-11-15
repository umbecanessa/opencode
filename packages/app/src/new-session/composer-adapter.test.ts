import { describe, expect, mock, test } from "bun:test"

const creates: Record<string, unknown>[] = []
let temporary = false

const data = {
  location: { info: () => ({ project: { canonical: "/proj" } }) },
  project: { invalidate: () => {}, sync: async () => {} },
  session: {
    create: (input: Record<string, unknown>) => {
      creates.push(input)

      return { id: "session-1", request: Promise.resolve() }
    },
    setStatus: () => {},
    prompt: () => {},
    input: { has: () => false },
    message: { get: () => undefined },
    get: () => undefined,
  },
}

mock.module("@/composer/persistence", () => ({
  useComposerState: () => ({ capture: () => ({}), ready: () => true }),
}))
mock.module("@/composer/selection", () => ({
  createComposerModelSelection: () => ({ remembered: () => ({}) }),
  createComposerControls: () => ({}),
}))
mock.module("./project/controller", () => ({
  createComposerProjectControls: () => ({}),
}))
mock.module("@/runtime/i18n/language", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
mock.module("@/providers/models/selection", () => ({
  useLocal: () => ({ agent: { current: () => "build" }, session: { promote: () => {} } }),
}))
mock.module("@/runtime/server/current", () => ({
  useData: () => data,
  useServer: () => ({ key: "local" }),
}))
mock.module("@/runtime/server/client", () => ({
  useServerSDK: () => ({ scope: "scope", api: { session: {} }, event: {} }),
}))
mock.module("@/shell/tabs/tabs", () => ({
  useTabs: () => ({ updateDraft: () => {}, promoteDraft: () => {}, prepareSession: () => ({}) }),
}))
mock.module("@/workspaces/location", () => ({
  useWorkspaceLocation: () => () => ({ directory: "/proj" }),
}))
mock.module("@/workspaces/create", () => ({
  createWorktree: async () => "/worktree",
}))
mock.module("@/shell/notifications/toast", () => ({
  showToast: () => {},
}))
mock.module("@/runtime/server/scope", () => ({
  SessionRouteKey: { fromRoute: (directory: string, id: string) => ({ directory, id }) },
  SessionStateKey: { from: () => "key" },
}))
mock.module("@/session/handoff", () => ({
  createSessionMessageHandoff: () => ({}),
}))

const { createNewSessionComposerAdapter } = await import("./composer-adapter")

function submit() {
  const adapter = createNewSessionComposerAdapter({
    draftID: "draft-1",
    worktree: () => "main",
    branch: () => undefined,
    temporary: () => temporary,
    submitted: () => {},
    mcp: { capture: () => ({}), prepare: async () => true, remember: () => {} } as never,
  })

  return adapter.adapter.start(
    { agent: "build", model: { modelID: "model", providerID: "provider" }, variant: undefined },
    { retarget: () => {}, target: () => ({}) } as never,
    { type: "user" } as never,
  )
}

describe("new session composer adapter creation", () => {
  test("sends the draft's temporary flag on the single session.create path", async () => {
    creates.length = 0
    temporary = false
    await submit()
    expect(creates.length).toBe(1)
    expect(creates[0]).not.toHaveProperty("temporary")

    temporary = true
    await submit()
    expect(creates.length).toBe(2)
    expect(creates[1]).toHaveProperty("temporary", true)
    expect(creates[1]).toHaveProperty("id")
    expect(creates[1]).toHaveProperty("location", { directory: "/proj" })
  })
})
