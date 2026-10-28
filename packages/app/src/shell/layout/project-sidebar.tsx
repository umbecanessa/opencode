import { For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { skipToken, useQuery } from "@tanstack/solid-query"
import { Icon } from "@opencode/ui/icon"
import { createHomeController } from "@/home/model"
import { loadHomeSessionIndex, mergeHomeSessionIndex } from "@/home/sessions/index"
import { ServerConnection } from "@/runtime/server/registry"
import { useLanguage } from "@/runtime/i18n/language"
import { useLayout } from "@/shell/state/layout"
import { useTabs } from "@/shell/tabs/tabs"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Schema } from "effect"
import { useSessionTabAvatarState } from "./project-avatar-state"

export function ProjectSidebar() {
  const home = createHomeController()
  const language = useLanguage()
  const layout = useLayout()
  const tabs = useTabs()
  const [state, setState] = createStore({ search: "" })
  const initialCollapsed: Record<string, boolean> = {}
  const [collapsed, setCollapsed] = persisted(Persist.window("navigation.projects.collapsed"), Schema.Record(Schema.String, Schema.Boolean), initialCollapsed)
  const query = useQuery(() => {
    const ctx = home.server.focusedContext()
    return {
      queryKey: ["home-sessions", home.server.focused()] as const,
      enabled: !!ctx && ctx.sdk.connection.status() === "connected",
      queryFn: ctx ? ({ signal }: { signal: AbortSignal }) => loadHomeSessionIndex((input, options) => ctx.sdk.api.session.list(input, options), signal) : skipToken,
      select: (sessions: Awaited<ReturnType<typeof loadHomeSessionIndex>>) => () => sessions,
      staleTime: 30_000, retry: false,
    }
  })
  const sessions = createMemo(() => mergeHomeSessionIndex(query.isPending ? [] : query.data?.() ?? [], home.server.focusedContext()?.data.session.list() ?? [])
    .filter((s) => !state.search || s.title?.toLowerCase().includes(state.search.toLowerCase()))
    .sort((a, b) => b.time.updated - a.time.updated))
  const projects = createMemo(() => {
    const known = home.project.list()
    return [...known, ...sessions().flatMap((s) => known.some((p) => p.id === s.projectID || p.worktree === s.location.directory) ? [] : [{ id: s.projectID, worktree: s.location.directory, expanded: false }])]
      .filter((p, i, all) => all.findIndex((item) => item.worktree === p.worktree) === i)
  })
  const row = (session: ReturnType<typeof sessions>[number]) => {
    const connection = home.server.focused()
    if (!connection) return null
    const status = useSessionTabAvatarState(() => ServerConnection.key(connection), () => session.id, () => true, () => session)
    const children = () => home.server.focusedContext()?.data.session.list().filter((s) => s.parentID === session.id) ?? []
    return <div><button type="button" class="flex w-full min-h-9 items-center gap-2 rounded-md px-3 py-1.5 text-start text-13-regular hover:bg-v2-background-interactive-base"
      classList={{ "bg-v2-background-interactive-base": (() => { const route = layout.route(); return route.type === "session" && route.sessionId === session.id })() }}
      onClick={() => { const conn = home.server.focused(); if (conn) home.project.openProjectSession(conn, session.location.directory, session) }}>
      <Icon name="chat" size="small" />
      <span class="min-w-0 flex-1 truncate">{session.title || language.t("sidebar.newSession")}</span>
      <Show when={status.loading()}><span class="size-2 shrink-0 animate-pulse rounded-full bg-v2-text-base" aria-label={language.t("sidebar.agentWorking")} /></Show>
      <Show when={!status.loading() && status.unread()}><Icon name="circle-check" size="small" /></Show>
    </button>
      <Show when={children().length > 0}><details class="ps-5 text-v2-text-weak">
        <summary class="cursor-pointer py-1 text-12-regular">{language.t("sidebar.subagents")}</summary>
        <For each={children()}>{(child) => <button type="button" class="block min-h-8 w-full truncate rounded-md px-3 text-start text-12-regular hover:bg-v2-background-interactive-base" onClick={() => {
          const conn = home.server.focused()
          if (conn) home.project.openProjectSession(conn, child.location.directory, child)
        }}>{child.title || child.agent}</button>}</For>
      </details></Show>
    </div>
  }
  return <nav aria-label={language.t("sidebar.projectNavigation")} class="flex min-h-0 flex-1 flex-col gap-3 text-v2-text-base">
    <input value={state.search} onInput={(event) => setState("search", event.currentTarget.value)} placeholder={language.t("sidebar.searchConversations")}
      aria-label={language.t("sidebar.searchConversations")} class="mx-2 min-h-9 rounded-md border border-v2-border-base bg-transparent px-3 text-13-regular outline-none focus:border-v2-text-base" />
    <Show when={home.server.list().length > 1}>
      <select aria-label={language.t("sidebar.host")} class="mx-2 min-h-9 rounded-md bg-v2-background-bg-base px-2 text-13-regular"
        value={home.selection.value().server} onChange={(event) => { const conn = home.server.list().find((s) => ServerConnection.key(s) === event.currentTarget.value); if (conn) home.selection.focusServer(conn) }}>
        <For each={home.server.list()}>{(conn) => <option value={ServerConnection.key(conn)}>{ServerConnection.key(conn)}</option>}</For>
      </select>
    </Show>
    <div class="min-h-0 flex-1 overflow-auto px-2">
      <For each={tabs.store.filter((tab) => tab.type === "draft")}>{(draft) => <button type="button" onClick={() => tabs.select(draft)} class="flex min-h-9 w-full items-center gap-2 rounded-md px-3 text-start text-13-regular hover:bg-v2-background-interactive-base">
        <Icon name="plus" size="small" /><span class="truncate">{language.t("sidebar.newSession")}</span>
      </button>}</For>
      <p class="px-3 pb-1 text-12-regular text-v2-text-weak">{language.t("sidebar.recentConversations")}</p>
      <For each={sessions().slice(0, 5)}>{row}</For>
      <p class="px-3 pb-1 pt-5 text-12-regular text-v2-text-weak">{language.t("sidebar.projects")}</p>
      <For each={projects()}>{(project) => {
        const key = () => `${home.selection.value().server}/${project.worktree}`
        const children = () => sessions().filter((s) => s.projectID === project.id || s.location.directory === project.worktree)
        return <section class="mb-2">
          <div class="flex items-center">
            <button type="button" aria-expanded={!collapsed[key()]} onClick={() => setCollapsed((current) => ({ ...current, [key()]: !current[key()] }))} class="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-start text-13-regular hover:bg-v2-background-interactive-base">
              <Icon name={collapsed[key()] ? "chevron-right" : "chevron-down"} size="small" />
              <span class="truncate">{project.worktree.replace(/[\\/]+$/, "").split(/[\\/]/).pop()}</span>
            </button>
            <button type="button" aria-label={language.t("sidebar.newSession")} class="flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-v2-background-interactive-base"
              onClick={() => { const conn = home.server.focused(); if (conn) home.project.openProjectNewSession(conn, project.worktree) }}><Icon name="plus" size="small" /></button>
          </div>
          <Show when={!collapsed[key()]}><div class="ps-3"><For each={children()}>{row}</For></div></Show>
        </section>
      }}</For>
      <Show when={query.isError}><p class="px-3 py-3 text-12-regular text-v2-text-weak">{language.t("sidebar.sessionsUnavailable")}</p></Show>
    </div>
  </nav>
}
