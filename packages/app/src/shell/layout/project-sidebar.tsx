import { For, Show, createEffect, createMemo, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { skipToken, useQuery, useQueryClient } from "@tanstack/solid-query"
import { Schema } from "effect"
import { Icon } from "@opencode/ui/icon"
import { Menu } from "@opencode/ui/menu"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogHeader, DialogTitleGroup, DialogFooter } from "@opencode/ui/dialog"
import { Button } from "@opencode/ui/button"
import { TextInput } from "@opencode/ui/text-input"
import { createHomeController } from "@/home/model"
import { loadHomeSessionIndex, mergeHomeSessionIndex } from "@/home/sessions/index"
import { ServerConnection, serverName } from "@/runtime/server/registry"
import { useLanguage } from "@/runtime/i18n/language"
import { useLayout } from "@/shell/state/layout"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { useDirectoryPicker } from "@/workspaces/selection/picker"
import { showToast } from "@/shell/notifications/toast"
import { notifySessionTabsRemoved } from "@/shell/titlebar/session-events"
import { sessionTreeIDs, sessionPermissionRequest, sessionFormRequest } from "@/session/requests/session-request-tree"
import { getRelativeTime } from "@/shell/time"
import type { SessionInfo } from "@opencode/client/promise"
import "./project-sidebar.css"

const LIST_LIMIT = 5

type Host = { connection: ServerConnection.Any; key: ReturnType<typeof ServerConnection.key>; ctx: ReturnType<ReturnType<typeof createHomeController>["server"]["context"]> }
type Entry = { host: Host; session: SessionInfo }

export function ProjectSidebar() {
  const home = createHomeController()
  const language = useLanguage()
  const layout = useLayout()
  const dialog = useDialog()
  const queryClient = useQueryClient()
  const pickDirectory = useDirectoryPicker()
  const initial: Record<string, boolean> = {}
  const [pinned, setPinned] = persisted(Persist.window("navigation.projects.pinned"), Schema.Record(Schema.String, Schema.Boolean), initial)
  const [collapsed, setCollapsed] = persisted(Persist.window("navigation.projects.collapsed"), Schema.Record(Schema.String, Schema.Boolean), initial)
  const [collapsedHosts, setCollapsedHosts] = persisted(Persist.window("navigation.hosts.collapsed"), Schema.Record(Schema.String, Schema.Boolean), initial)
  const [state, setState] = createStore({
    search: "",
    recentExpanded: false,
    removed: [] as string[],
    failed: [] as string[],
    busy: undefined as string | undefined,
    byHost: {} as Record<string, SessionInfo[]>,
    expandedProjects: {} as Record<string, boolean>,
    expandedHosts: {} as Record<string, boolean>,
  })
  const hosts = createMemo(() => home.server.list().map((connection) => ({ connection, key: ServerConnection.key(connection), ctx: home.server.context(connection) })))
  const search = () => state.search.trim().toLowerCase()
  const entries = createMemo(() => hosts().flatMap((host) => (state.byHost[host.key] ?? [])
    .filter((session) => !session.parentID && !state.removed.includes(session.id) && !session.time.archived && (!search() || session.title?.toLowerCase().includes(search())))
    .map((session) => ({ host, session }))))
  const sorted = createMemo(() => [...entries()].sort((a, b) => Number(!!pinned[b.session.id]) - Number(!!pinned[a.session.id]) || b.session.time.updated - a.session.time.updated))
  const recent = createMemo(() => (state.recentExpanded ? sorted() : sorted().slice(0, LIST_LIMIT)))
  const failure = (error: Error) => showToast({ title: language.t("common.requestFailed"), description: error.message })
  const settle = (host: Host, session: SessionInfo, ids: string[]) => {
    setState("removed", (current) => [...current, ...ids])
    notifySessionTabsRemoved({ server: host.key, directory: session.location.directory, sessionIDs: ids })
    queryClient.invalidateQueries({ queryKey: ["home-sessions", host.connection], exact: true })
  }
  const archive = async (host: Host, session: SessionInfo) => {
    setState("busy", session.id)
    await host.ctx.sdk.api.session.update({ sessionID: session.id, archived: true }).then(() => {
      setState("removed", (current) => [...current, session.id])
      notifySessionTabsRemoved({ server: host.key, directory: session.location.directory, sessionIDs: sessionTreeIDs(host.ctx.data.session.list(), session.id) })
      queryClient.invalidateQueries({ queryKey: ["home-sessions", host.connection], exact: true })
    }).catch(failure)
    setState("busy", undefined)
  }
  const fork = async (host: Host, session: SessionInfo) => {
    setState("busy", session.id)
    await host.ctx.sdk.api.session.fork({ sessionID: session.id }).then((forked) => {
      queryClient.invalidateQueries({ queryKey: ["home-sessions", host.connection], exact: true })
      home.project.openProjectSession(host.connection, forked.location.directory, forked)
    }).catch(failure)
    setState("busy", undefined)
  }
  const rename = (host: Host, session: SessionInfo) => {
    const save = async (title: string) => {
      const next = title.trim()
      if (!next || next === session.title) {
        dialog.close()
        return
      }
      setState("busy", session.id)
      await host.ctx.sdk.api.session.update({ sessionID: session.id, title: next }).then(() => {
        // Rename advances time.updated server-side; patch the cache, then re-fetch so
        // ordering and date grouping do not go stale.
        host.ctx.data.session.remember({ ...(host.ctx.data.session.get(session.id) ?? session), title: next })
        host.ctx.data.session.invalidate(session.id)
        void host.ctx.data.session.sync(session.id).catch(() => {})
        queryClient.invalidateQueries({ queryKey: ["home-sessions", host.connection], exact: true })
        dialog.close()
      }).catch(failure)
      setState("busy", undefined)
    }
    void dialog.show(() => <RenameDialog initial={session.title ?? ""} busy={() => !!state.busy} onCancel={() => dialog.close()} onSave={save} />)
  }
  const remove = (host: Host, session: SessionInfo) => {
    const confirm = async () => {
      setState("busy", session.id)
      const ids = sessionTreeIDs(host.ctx.data.session.list(), session.id)
      await host.ctx.data.session.remove(session.id).then(() => {
        settle(host, session, ids)
        dialog.close()
      }).catch(failure)
      setState("busy", undefined)
    }
    void dialog.show(() => <Dialog fit><DialogHeader hideClose><DialogTitleGroup title={language.t("session.delete.title")} description={language.t("session.delete.confirm", { name: session.title ?? language.t("command.session.new") })} /></DialogHeader>
      <DialogFooter><Button variant="ghost" onClick={() => dialog.close()}>{language.t("common.cancel")}</Button><Button variant="danger" disabled={!!state.busy} onClick={confirm}>{language.t("session.delete.button")}</Button></DialogFooter></Dialog>)
  }
  const status = (host: Host, session: SessionInfo) => {
    const all = host.ctx.data.session.list()
    if (sessionPermissionRequest(all, host.ctx.data.session.permission.list, session.id) || sessionFormRequest(all, host.ctx.data.session.form.list, session.id)) return "waiting"
    if (sessionTreeIDs(all, session.id).some((id) => host.ctx.data.session.status(id) === "running")) return "running"
    if (session.outcome === "failed") return "failed"
    // Finished turns the user has not opened yet read as a distinct blue dot.
    if (host.ctx.notification.session.unread(session.id, session)) return "unread"
    return "done"
  }
  const active = (host: Host, session: SessionInfo) => {
    const route = layout.route()
    return route.type === "session" && route.server === host.key && route.sessionId === session.id
  }
  const open = (entry: Entry) => home.project.openProjectSession(entry.host.connection, entry.session.location.directory, entry.session)
  const row = (entry: Entry, showHost = false) => <div class="sidebar-row flex min-w-0 items-center" classList={{ "sidebar-row-active": active(entry.host, entry.session) }}>
    <button type="button" class="flex min-h-9 min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-start text-13-regular" onClick={() => open(entry)}>
      <span class="sidebar-status" data-status={status(entry.host, entry.session)} title={language.t(`sidebar.status.${status(entry.host, entry.session)}`)} />
      <span class="min-w-0 flex-1 truncate">{entry.session.title || language.t("command.session.new")}</span>
      <Show when={pinned[entry.session.id]}><span class="sidebar-pin" aria-label={language.t("sidebar.pin")} /></Show>
      <Show when={showHost}><span class="sidebar-host truncate">{serverName(entry.host.connection)}</span></Show>
      <span class="shrink-0 text-12-regular text-v2-text-text-faint" title={new Date(entry.session.time.updated).toLocaleString()}>{getRelativeTime(new Date(entry.session.time.updated).toISOString(), language.t)}</span>
    </button>
    <Menu placement="bottom-end" modal={false}><Menu.Trigger aria-label={language.t("common.moreOptions")} class="sidebar-menu flex size-7 shrink-0 items-center justify-center rounded-md"><Icon name="outline-dots" size="small" /></Menu.Trigger>
      <Menu.Portal><Menu.Content>
        <Menu.Item onSelect={() => setPinned((current) => ({ ...current, [entry.session.id]: !current[entry.session.id] }))}>{language.t(pinned[entry.session.id] ? "sidebar.unpin" : "sidebar.pin")}</Menu.Item>
        <Menu.Item disabled={!!state.busy} onSelect={() => fork(entry.host, entry.session)}>{language.t("sidebar.fork")}</Menu.Item>
        <Menu.Item disabled={!!state.busy} onSelect={() => rename(entry.host, entry.session)}>{language.t("common.rename")}</Menu.Item>
        <Menu.Item disabled={!!state.busy} onSelect={() => archive(entry.host, entry.session)}>{language.t("sidebar.archive")}</Menu.Item>
        <Menu.Separator /><Menu.Item disabled={!!state.busy} onSelect={() => remove(entry.host, entry.session)}>{language.t("session.delete.button")}</Menu.Item>
      </Menu.Content></Menu.Portal>
    </Menu>
  </div>
  const showMore = (expanded: boolean, toggle: () => void) => <button type="button" onClick={toggle} class="min-h-8 w-full rounded-md px-3 text-start text-12-regular text-v2-text-text-faint hover:text-v2-text-text-base">
    {language.t(expanded ? "sidebar.showLess" : "sidebar.showMore")}
  </button>
  const add = (connection: ServerConnection.Any) => pickDirectory({ server: connection, title: language.t("command.project.open"), multiple: true,
    onSelect: (result) => { if (result) home.project.add(connection, Array.isArray(result) ? result : [result]) } })
  return <nav aria-label={language.t("sidebar.projectNavigation")} class="project-navigation flex min-h-0 flex-1 flex-col gap-1 text-v2-text-text-base">
    <div class="flex items-center gap-1 px-2 pt-1">
      <input value={state.search} onInput={(event) => setState("search", event.currentTarget.value)} placeholder={language.t("sidebar.searchConversations")}
        aria-label={language.t("sidebar.searchConversations")} class="min-h-8 min-w-0 flex-1 rounded-md border-none bg-v2-background-bg-layer-01 px-2.5 text-13-regular text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint focus-visible:bg-v2-background-bg-layer-02" />
      <Menu placement="bottom-end"><Menu.Trigger aria-label={language.t("command.project.open")} class="sidebar-quiet flex size-8 shrink-0 items-center justify-center rounded-md"><Icon name="plus-small" size="small" /></Menu.Trigger>
        <Menu.Portal><Menu.Content><For each={home.server.list()}>{(connection) => <Menu.Item onSelect={() => add(connection)}>
          <span class="flex w-full items-center justify-between gap-3"><span>{language.t("command.project.open")}</span><span class="sidebar-host shrink-0">{serverName(connection)}</span></span>
        </Menu.Item>}</For></Menu.Content></Menu.Portal>
      </Menu>
    </div>
    <div class="min-h-0 flex-1 overflow-auto px-2 pb-4">
      <div class="sidebar-label px-2 pb-1 pt-3">{language.t("sidebar.recentConversations")}</div>
      <For each={recent()}>{(entry) => row(entry, true)}</For>
      <Show when={sorted().length > LIST_LIMIT}>{showMore(state.recentExpanded, () => setState("recentExpanded", (current) => !current))}</Show>
      <For each={hosts()}>{(host) => <HostProjects host={host} entries={entries()} collapsedKey={(worktree) => `${host.key}\u0000${worktree}`} collapsed={collapsed} toggleCollapsed={(worktree) => setCollapsed((current) => ({ ...current, [`${host.key}\u0000${worktree}`]: !current[`${host.key}\u0000${worktree}`] }))}
        hostCollapsed={!!collapsedHosts[host.key]} toggleHost={() => setCollapsedHosts((current) => ({ ...current, [host.key]: !current[host.key] }))}
        projectsExpanded={!!state.expandedHosts[host.key]} toggleHostProjects={() => setState("expandedHosts", host.key, (current) => !current)}
        expandedProjects={state.expandedProjects} toggleProject={(id) => setState("expandedProjects", id, (current) => !current)}
        failed={state.failed.includes(host.key)} openNewSession={(worktree) => home.project.openProjectNewSession(host.connection, worktree)} row={row} />}</For>
    </div>
    <For each={hosts()}>{(host) => <HostSessions connection={host.connection} onData={(list, failed) => {
      setState("byHost", host.key, list)
      setState("failed", (current) => failed ? [...new Set([...current, host.key])] : current.filter((key) => key !== host.key))
    }} />}</For>
  </nav>
}

function HostProjects(props: {
  host: Host
  entries: Entry[]
  collapsedKey: (worktree: string) => string
  collapsed: Record<string, boolean>
  toggleCollapsed: (worktree: string) => void
  hostCollapsed: boolean
  toggleHost: () => void
  projectsExpanded: boolean
  toggleHostProjects: () => void
  expandedProjects: Record<string, boolean>
  toggleProject: (id: string) => void
  failed: boolean
  openNewSession: (worktree: string) => void
  row: (entry: Entry) => JSX.Element
}) {
  const language = useLanguage()
  const hostEntries = createMemo(() => props.entries.filter((entry) => entry.host.key === props.host.key))
  // Projects come from this host's own registry plus the directories its own sessions live in.
  // Sessions from other hosts never contribute projects here, even when the path is identical.
  const projects = createMemo(() => {
    const known = props.host.ctx.projects.list()
    return [...known, ...hostEntries().flatMap((entry) => known.some((project) => project.id === entry.session.projectID || project.worktree === entry.session.location.directory) ? [] : [{ id: entry.session.projectID, worktree: entry.session.location.directory }])]
      .filter((project, index, all) => all.findIndex((item) => item.worktree === project.worktree) === index)
      .sort((a, b) => lastUsed(b, hostEntries()) - lastUsed(a, hostEntries()))
  })
  const shownProjects = createMemo(() => (props.projectsExpanded ? projects() : projects().slice(0, LIST_LIMIT)))
  const projectEntries = (project: { id?: string; worktree: string }) => hostEntries().filter((entry) => entry.session.projectID === project.id || entry.session.location.directory === project.worktree)
  const hostOpen = () => !props.hostCollapsed
  return <section class="pb-2">
    <div class="flex items-center">
      <button type="button" aria-expanded={hostOpen()} onClick={props.toggleHost} class="sidebar-row sidebar-host-label flex min-h-8 min-w-0 flex-1 items-center gap-1 rounded-md px-2 pb-1 pt-4 text-start text-12-regular">
        <Icon name={hostOpen() ? "chevron-down" : "chevron-right"} size="small" />
        <span class="truncate">{serverName(props.host.connection)}</span>
      </button>
    </div>
    <Show when={props.failed}><p class="px-2 py-1 text-12-regular text-v2-text-text-faint">{language.t("sidebar.sessionsUnavailable")}</p></Show>
    <Show when={hostOpen()}>
    <For each={shownProjects()}>{(project) => {
      const sessions = () => projectEntries(project)
      const expanded = () => !!props.expandedProjects[`${props.host.key}\u0000${project.worktree}`]
      const shown = () => (expanded() ? sessions() : sessions().slice(0, LIST_LIMIT))
      const open = () => !props.collapsed[props.collapsedKey(project.worktree)]
      return <section class="mb-1">
        <div class="flex items-center">
          <button type="button" aria-expanded={open()} onClick={() => props.toggleCollapsed(project.worktree)} class="sidebar-row flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-start text-13-regular">
            <Icon name={open() ? "chevron-down" : "chevron-right"} size="small" /><Icon name="folder" size="small" />
            <span class="truncate" title={project.worktree}>{project.worktree.replace(/[\\/]+$/, "").split(/[\\/]/).pop()}</span>
          </button>
          <Menu placement="bottom-end" modal={false}><Menu.Trigger aria-label={language.t("common.moreOptions")} class="sidebar-menu flex size-7 shrink-0 items-center justify-center rounded-md"><Icon name="outline-dots" size="small" /></Menu.Trigger>
            <Menu.Portal><Menu.Content><Menu.Item onSelect={() => props.openNewSession(project.worktree)}>{language.t("command.session.new")}</Menu.Item></Menu.Content></Menu.Portal>
          </Menu>
        </div>
        <Show when={open()}><div class="ps-3">
          <For each={shown()}>{(entry) => props.row(entry)}</For>
          <Show when={sessions().length > LIST_LIMIT}><button type="button" onClick={() => props.toggleProject(`${props.host.key}\u0000${project.worktree}`)} class="min-h-8 w-full rounded-md px-3 text-start text-12-regular text-v2-text-text-faint hover:text-v2-text-text-base">{language.t(expanded() ? "sidebar.showLess" : "sidebar.showMore")}</button></Show>
        </div></Show>
      </section>
    }}</For>
    <Show when={projects().length > LIST_LIMIT}><button type="button" onClick={props.toggleHostProjects} class="min-h-8 w-full rounded-md px-3 text-start text-12-regular text-v2-text-text-faint hover:text-v2-text-text-base">{language.t(props.projectsExpanded ? "sidebar.showLess" : "sidebar.showMore")}</button></Show>
    </Show>
  </section>
}

function lastUsed(project: { id?: string; worktree: string }, entries: Entry[]) {
  return Math.max(0, ...entries.filter((entry) => entry.session.projectID === project.id || entry.session.location.directory === project.worktree).map((entry) => entry.session.time.updated))
}

function RenameDialog(props: { initial: string; busy: () => boolean; onCancel: () => void; onSave: (title: string) => void }) {
  const language = useLanguage()
  const [draft, setDraft] = createStore({ title: props.initial })
  const submit = () => {
    if (props.busy() || !draft.title.trim()) return
    props.onSave(draft.title)
  }
  return <Dialog fit><DialogHeader hideClose><DialogTitleGroup title={language.t("common.rename")} /></DialogHeader>
    <div class="px-1 pb-1"><TextInput appearance="large" autofocus value={draft.title} aria-label={language.t("common.rename")}
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit() } }}
      onInput={(event) => setDraft("title", event.currentTarget.value)} /></div>
    <DialogFooter><Button variant="ghost" disabled={props.busy()} onClick={props.onCancel}>{language.t("common.cancel")}</Button><Button disabled={props.busy() || !draft.title.trim()} onClick={submit}>{language.t("common.save")}</Button></DialogFooter></Dialog>
}

function HostSessions(props: { connection: ServerConnection.Any; onData: (sessions: SessionInfo[], failed: boolean) => void }) {
  const home = createHomeController()
  const ctx = () => home.server.context(props.connection)
  const query = useQuery(() => ({
    queryKey: ["home-sessions", props.connection] as const,
    enabled: ctx().sdk.connection.status() === "connected",
    queryFn: ctx() ? ({ signal }: { signal: AbortSignal }) => loadHomeSessionIndex((input, options) => ctx().sdk.api.session.list(input, options), signal) : skipToken,
    select: (sessions: Awaited<ReturnType<typeof loadHomeSessionIndex>>) => () => sessions,
    staleTime: 30_000, refetchInterval: 30_000, retry: false,
  }))
  createEffect(() => props.onData(mergeHomeSessionIndex(query.data?.() ?? [], ctx().data.session.list()), query.isError))
  return null
}
