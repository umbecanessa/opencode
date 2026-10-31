import { NodeHttpClient } from "@effect/platform-node"
import { Browser } from "@opencode/plugin-browser/rpc"
import { OpenCode } from "@opencode/client/effect"
import { SessionID } from "@opencode/schema/session-id"
import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import path from "node:path"
import electron, { type BrowserWindow } from "electron"
import { Deferred, Effect, ManagedRuntime, Option, Predicate, Queue, Schedule, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { BuiltinMainStorage } from "@opencode/plugin/gui/builtin"
import type { Embeds, Persisted, ServerEndpoints, Windows } from "@opencode/plugin/gui/main"
import { createBrowserPage, type BrowserPage, type ScrollPosition, type Shared } from "./chromium"
import { runCookieCommand } from "./cookies"
import { browserFailure } from "./errors"
import { createBrowserNetwork, type BrowserNetwork } from "./network"
import { destinationOrigin, fileURLWithin, refusal } from "./policy"
import { createRefs } from "./refs"
import type { PaneEvent } from "./ipc"
import { createBrowserRestoreStore } from "./restore"

/** The cookie actions, which answer from the pane's persisted jar instead of a page. */
type CookieAction = Extract<Browser.Action, { type: `cookies.${string}` }>

type Target = { readonly server: string; readonly session: string; readonly restore?: Browser.State }

/**
 * The persisted partition for a server+session pair. The server half is hashed to keep the name
 * short and legal; the session half stays readable, so the partition sweep can list a server's
 * partitions on disk and ask it about each one without a stored manifest.
 */
function partitionName(server: string, sessionID: string) {
  return `persist:opencode-browser-${createHash("sha256").update(server).digest("hex").slice(0, 12)}-${sessionID}`
}

type Entry = {
  binding: string
  window: number
  win: BrowserWindow
  abort: AbortController
  registered: ReturnType<typeof Promise.withResolvers<void>>
  requests: Map<string, { abort: AbortController; tabID?: Browser.TabID }>
  report?: (event: PaneEvent) => void
  cleanup?: () => void
  pages: Map<Browser.TabID, BrowserPage>
  tabs: Map<Browser.TabID, Browser.Tab>
  /** Scroll offsets per tab - window and inner scrollers - from the live pages and the restore store. */
  scrolls: Map<Browser.TabID, ScrollPosition>
  focusedTabID: Browser.TabID | null
  partition: string
  lastState?: string
  network?: BrowserNetwork
  storageKey: string
  /**
   * Workspace directories whose files may load as file:// documents. Set only for the desktop's
   * own sidecar: a forwarded or explicit loopback server does not share this machine's disk.
   */
  fileRoots: string[]
}

export type Pane = ReturnType<typeof createBrowserPane>

export function createBrowserPane(input: {
  readonly windows: Windows
  readonly serverEndpoints: ServerEndpoints
  readonly storage: BuiltinMainStorage
  /** The declared store of reserved element refs. */
  readonly refs: Persisted<number, number>
  readonly embeds: Embeds
  readonly emit: (window: number, value: { readonly binding: string; readonly event: PaneEvent }) => void
}) {
  const entries = new Map<string, Entry>()
  const restore = createBrowserRestoreStore(input.storage)
  const shared: Shared = { ref: createRefs(input.refs) }
  // Page disposals in flight. Finishing a trace or CPU profile can hold a page open, and the pane's own disposal waits
  // for them so a replacement never starts beside old pages still recording.
  const releasing = new Set<Promise<void>>()
  // Keep long-lived RPC requests off Chromium's shared HTTP connection pool.
  const runtime = ManagedRuntime.make(NodeHttpClient.layerNodeHttp)
  // When each server's partitions were last swept, so wakes and several windows do not walk the
  // same server's directory repeatedly.
  const swept = new Map<string, number>()
  let disposed = false

  return {
    async register(window: number, binding: string, target: Target) {
      const server = input.serverEndpoints.get(target.server)

      if (disposed || !server || !destinationOrigin(server.url)) throw new Error("browser.pane.registration.invalid")

      const win = input.windows.get(window)

      if (!win || entries.has(binding)) throw new Error("browser.pane.owner.invalid")

      if (win.isDestroyed() || win.webContents.isDestroyed()) throw new Error("browser.pane.owner.unavailable")
      const sessionID = SessionID.make(target.session)
      const storageKey = `${target.server}\n${sessionID}`
      const saved = restore.load(storageKey)

      const previous = target.restore ?? {
        tabs: saved.tabs.map((tab) => ({
          id: tab.id,
          url: tab.url,
          title: "",
          generation: 0,
        })),
        focusedTabID: saved.focusedTabID,
      }

      const entry: Entry = {
        binding,
        window,
        win,
        abort: new AbortController(),
        registered: Promise.withResolvers(),
        requests: new Map(),
        pages: new Map(),
        tabs: new Map(
          previous.tabs.map((tab) => [
            tab.id,
            {
              ...tab,
              loading: false,
              canGoBack: false,
              canGoForward: false,
              generation: tab.generation + 1,
            },
          ]),
        ),
        // Revived tabs keep the offsets their last page reported, newest of the store and any live report.
        scrolls: new Map(
          saved.tabs.flatMap((tab) =>
            tab.scrollX || tab.scrollY || tab.scrollInner?.length
              ? ([[tab.id, { x: tab.scrollX ?? 0, y: tab.scrollY ?? 0, inner: tab.scrollInner }]] as const)
              : [],
          ),
        ),
        focusedTabID: previous.focusedTabID,
        // A persisted partition named for this server+session pair: its cookies and site data
        // survive browser and app restarts, like the restored tab list it belongs to. It is
        // per-session rather than per-server so each attachment's tunnel proxy (set on the whole
        // partition) stays its own, and it is emptied when the session is deleted (see purge).
        partition: partitionName(target.server, target.session),
        storageKey,
        fileRoots: [],
      }

      // Navigation guards cover documents; subresources (img, script, fetch) also must not read
      // file: URLs outside the roots. One listener per partition covers every page in this attachment.
      electron.session
        .fromPartition(entry.partition)
        .webRequest.onBeforeRequest({ urls: ["file://*/*"] }, (details, callback) =>
          callback({ cancel: !fileURLWithin(details.url, entry.fileRoots) }),
        )

      // "unsupported" means the server has no browser plugin; the renderer stops retrying.
      let reason:
        | "browser.pane.unsupported"
        | "browser.pane.replaced"
        | "browser.pane.suspended"
        | "browser.pane.missing"
        | undefined

      let attached = false
      const stop = () => close(entry, reason)

      const navigate = (event: Electron.Event<{ isMainFrame: boolean; isSameDocument: boolean }>) => {
        if (event.isMainFrame && !event.isSameDocument) stop()
      }

      win.webContents.once("destroyed", stop)
      win.webContents.on("did-start-navigation", navigate)
      entry.cleanup = () => {
        if (win.isDestroyed()) return
        win.webContents.off("destroyed", stop)
        win.webContents.off("did-start-navigation", navigate)
      }

      entries.set(binding, entry)
      void runtime
        .runPromise(
          Effect.gen(function* () {
            const http = yield* HttpClient.HttpClient

            // The renderer never holds the managed sidecar's password; Node requests bypass
            // the webRequest header injection, so the host resolves the credential here in main.
            const client = yield* OpenCode.make({ baseUrl: server.url }).pipe(
              Effect.provideService(
                HttpClient.HttpClient,
                Object.keys(server.headers).length
                  ? HttpClient.mapRequest(http, HttpClientRequest.setHeaders(server.headers))
                  : http,
              ),
            )

            // A session deleted while no pane was attached: its jar goes now, and the registration
            // fails exactly as any other get failure does.
            const session = yield* client.session.get({ sessionID }).pipe(
              Effect.catchIf(
                (error) => Predicate.isTagged(error, "SessionNotFoundError"),
                (error) =>
                  Effect.sync(() => purge(target.server, target.session)).pipe(Effect.andThen(Effect.fail(error))),
              ),
            )

            // Partitions whose sessions were deleted since the last walk do not wait for a wake:
            // one bounded sweep per server per half hour, beside the attachment's own lifetime.
            if (Date.now() - (swept.get(target.server) ?? 0) > 30 * 60_000) {
              swept.set(target.server, Date.now())
              yield* purgeStale(target.server, (id) => client.session.get({ sessionID: id })).pipe(
                Effect.catchCause((cause) => Effect.logWarning("Browser partition sweep failed", cause)),
                Effect.forkScoped,
              )
            }

            // The agent can already read this workspace, so showing its files adds no access.
            if (server.sameMachine) entry.fileRoots = [session.location.directory]

            const options = {
              location: { directory: session.location.directory, workspace: session.location.workspaceID },
            }

            const attachment = { sessionID, connectionID: crypto.randomUUID() }
            const rpc = client.rpc(Browser.Definition)
            entry.network = yield* createBrowserNetwork({
              rpc,
              attachment,
              location: options.location,
              partition: entry.partition,
            })
            const connected = yield* Deferred.make<void>()
            const outbound = yield* Queue.unbounded<Effect.Effect<void>>()

            // A send that fails because the server already replaced or closed this attachment must
            // not decide the close reason; only the attach call's outcome does.
            const send = (effect: Effect.Effect<unknown, unknown>) =>
              Queue.offerUnsafe(
                outbound,
                effect.pipe(Effect.catchCause((cause) => Effect.logWarning("Browser send failed", cause))),
              )

            const reply = (requestID: string, outcome: Browser.Outcome) =>
              send(
                rpc.result({ ...attachment, requestID, outcome: Schema.encodeSync(Browser.Outcome)(outcome) }, options),
              )

            // The window hears every event at once; it never waits on the server, which can stall for
            // hundreds of milliseconds while it serves the page's own traffic. The server's copy of the
            // inventory resolves every tab ID, so a state is retried until it arrives or the attachment
            // ends; the results queued behind it then never name a tab the server lacks. "unavailable"
            // means the server already dropped this attachment, which attach reports.
            entry.report = (event) => {
              publish(entry, event)

              if (event.type !== "state") return
              send(
                rpc.state({ ...attachment, state: event.state ?? { tabs: [], focusedTabID: null } }, options).pipe(
                  Effect.retry({
                    while: (error) => !("type" in error && error.type === "unavailable"),
                    schedule: Schedule.min([Schedule.exponential("250 millis"), Schedule.spaced("10 seconds")]),
                  }),
                ),
              )
            }

            const receive = client.event.subscribe().pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  if (event.type === "server.connected") {
                    yield* Deferred.succeed(connected, undefined)

                    return
                  }

                  // Deletions ride this stream: the session's panes close and its jar empties at
                  // once, without waiting for a wake or a sweep. Forked because purging this very
                  // session closes the entry and interrupts the fiber running this callback.
                  if (event.type === "session.deleted")
                    return yield* Effect.sync(() => purge(target.server, event.data.sessionID)).pipe(Effect.forkScoped)

                  if (
                    event.type !== "rpc.experimental.browser.control" ||
                    event.data.connectionID !== attachment.connectionID
                  )
                    return

                  const message = yield* Schema.decodeUnknownEffect(Browser.Control)(event.data).pipe(
                    Effect.tapError(() =>
                      Effect.sync(() => {
                        reason = "browser.pane.unsupported"
                      }),
                    ),
                  )

                  if (message.type === "attached") {
                    attached = true

                    return entry.registered.resolve()
                  }

                  if (message.type === "cancel") return entry.requests.get(message.requestID)?.abort.abort()
                  const abort = new AbortController()
                  entry.requests.set(message.requestID, { abort })
                  yield* rpc.command({ ...attachment, requestID: message.requestID }, options).pipe(
                    Effect.flatMap((command) =>
                      Effect.promise(async () => {
                        entry.requests.set(
                          message.requestID,
                          "tabID" in command.action ? { abort, tabID: command.action.tabID } : { abort },
                        )
                        reply(
                          message.requestID,
                          await execute(entry, command, abort.signal).then(
                            (result) => ({ type: "success" as const, result }),
                            (cause: unknown) => browserFailure(command.action, cause),
                          ),
                        )
                      }),
                    ),
                    Effect.ensuring(Effect.sync(() => entry.requests.delete(message.requestID))),
                    // An operation this desktop cannot decode comes from a newer plugin; answer it so
                    // the agent does not wait out the server's timeout.
                    Effect.tapError((error) =>
                      Effect.sync(() => {
                        if (!Schema.isSchemaError(error)) return
                        reply(message.requestID, {
                          type: "failure",
                          code: "unsupported",
                          message:
                            "This desktop app does not support the requested browser operation. Ask the user to update the desktop app, or use another operation.",
                        })
                      }),
                    ),
                    // A request that vanished (cancelled before retrieval) fails only that request.
                    // Transport loss surfaces through the event stream and attach call instead.
                    Effect.catchCause((cause) =>
                      abort.signal.aborted ? Effect.void : Effect.logWarning("Browser command failed", cause),
                    ),
                    Effect.forkScoped,
                  )
                }),
              ),
            )

            yield* Effect.raceAllFirst([
              receive,
              Stream.fromQueue(outbound).pipe(Stream.runForEach((send) => send)),
              Deferred.await(connected).pipe(
                Effect.andThen(rpc.attach({ ...attachment, version: 4 }, options)),
                Effect.tap((result) =>
                  Effect.sync(() => {
                    if (result === "replaced") reason = "browser.pane.replaced"
                  }),
                ),
              ),
            ])
          }).pipe(
            Effect.scoped,
            Effect.tapError((error) =>
              Effect.sync(() => {
                if (Predicate.isTagged(error, "SessionNotFoundError")) {
                  reason = "browser.pane.missing"
                  restore.remove(entry.storageKey)

                  return
                }

                const type = error instanceof Object && "type" in error ? error.type : undefined

                if (type === "rpc.unavailable" && attached) {
                  reason = "browser.pane.suspended"

                  return
                }

                if (type === "rpc.unavailable" || type === "rpc.method_not_found" || type === "rpc.invalid_input")
                  reason = "browser.pane.unsupported"
              }),
            ),
            Effect.ensuring(Effect.sync(stop)),
          ),
          { signal: entry.abort.signal },
        )
        .catch(stop)
      const timeout = setTimeout(stop, 15_000)
      await entry.registered.promise.finally(() => clearTimeout(timeout))

      if (entries.get(binding) !== entry) throw new Error("browser.pane.registration.closed")
      publishState(entry)
    },
    load(window: number, binding: string, tabID: Browser.TabID) {
      load(owned(window, binding), tabID)
    },
    async inspect(window: number, binding: string, tabID: Browser.TabID, enabled: boolean) {
      await owned(window, binding).pages.get(tabID)?.inspect(enabled)
    },
    async highlight(window: number, binding: string, tabID: Browser.TabID, ref?: Browser.Ref) {
      await owned(window, binding).pages.get(tabID)?.highlight(ref)
    },
    zoom(window: number, binding: string, tabID: Browser.TabID, direction: "in" | "out" | "reset") {
      owned(window, binding).pages.get(tabID)?.zoom(direction)
    },
    async site(window: number, binding: string, tabID: Browser.TabID) {
      return (await owned(window, binding).pages.get(tabID)?.site()) ?? { cookies: 0 }
    },
    async clearSite(window: number, binding: string, tabID: Browser.TabID) {
      await owned(window, binding).pages.get(tabID)?.clearSite()
    },
    async command(window: number, binding: string, command: Browser.Action) {
      const entry = owned(window, binding)
      const url = command.type === "navigate" || command.type === "tabs.open" ? command.url : undefined
      // The window explains a refused address by its code; the agent's commands get main's own message instead.
      const reason = url === undefined ? undefined : refusal(url, { fileRoots: entry.fileRoots })

      if (reason) throw new Error(reason)
      // A navigation that the next one replaced, such as a second submit or a redirect, rejects with ERR_ABORTED while
      // the tab goes on loading. It is not a failed request; a page that fails to load reports its own error.
      await execute(entry, { action: command, files: [] }, new AbortController().signal).catch((error: Error) => {
        if (!("code" in error) || error.code !== "ERR_ABORTED") throw error
      })
    },
    async close(window: number, binding: string) {
      const entry = owned(window, binding)
      restore.remove(entry.storageKey)
      close(entry)
      // Caches are the bulk of a partition and rebuild themselves, so closing a session's browser
      // drops them. Cookies and origin storage stay: reopening the session keeps its logins.
      void electron.session
        .fromPartition(entry.partition)
        .clearStorageData({ storages: ["cachestorage", "shadercache"] })
        .catch(() => undefined)
    },
    /**
     * The plugin is going away (reload, disable, or quit). Windows keep each pane's tabs as a
     * suspended attachment, like an idle server eviction, and register again once the pane is back.
     */
    async dispose() {
      disposed = true
      entries.forEach((entry) => close(entry, "browser.pane.suspended"))
      await Promise.all(releasing)
      await runtime.dispose()
    },
  }

  function owned(window: number, binding: string) {
    const entry = entries.get(binding)

    if (!entry || entry.window !== window) throw new Error("browser.pane.unavailable")

    return entry
  }

  function publish(entry: Entry, event: PaneEvent) {
    if (!entries.has(entry.binding) || entry.win.isDestroyed() || entry.win.webContents.isDestroyed()) return
    input.emit(entry.window, { binding: entry.binding, event })
  }

  function close(entry: Entry, reason = "browser.pane.registration.closed") {
    if (entries.get(entry.binding) !== entry) return
    entry.report = undefined
    entry.requests.forEach((request) => request.abort.abort())
    entry.requests.clear()
    const suspended = reason === "browser.pane.suspended"

    if (suspended) publishState(entry, reason)
    entry.pages.forEach((page) => void release(page).catch(() => undefined))
    entry.pages.clear()
    entry.tabs.clear()
    entry.focusedTabID = null

    if (!suspended) publishState(entry, reason)
    entries.delete(entry.binding)
    entry.registered.reject(new Error("browser.pane.registration.closed"))
    entry.cleanup?.()
    entry.abort.abort()
  }

  /**
   * A deleted session's browser goes with it: panes showing it close, its restored tabs are
   * forgotten, and its partition is emptied. The directory itself stays - Electron has no
   * partition-delete API and Chromium owns its files - but no cookie or site data survives.
   */
  function purge(server: string, sessionID: string) {
    const key = `${server}\n${sessionID}`

    entries.forEach((entry) => {
      if (entry.storageKey === key) close(entry)
    })
    restore.remove(key)
    void electron.session
      .fromPartition(partitionName(server, sessionID))
      .clearStorageData()
      .catch(() => undefined)
  }

  /**
   * Deletes a server's stale partitions: a jar goes only when the server itself answers
   * SessionNotFoundError for the session named in the directory. Any other answer - offline,
   * auth, a server still loading - fails the walk and keeps every jar, and a partition a live
   * pane is using is never questioned, only kept.
   */
  function purgeStale(
    server: string,
    get: (sessionID: SessionID) => Effect.Effect<unknown, unknown>,
  ) {
    return Effect.gen(function* () {
      const prefix = `opencode-browser-${createHash("sha256").update(server).digest("hex").slice(0, 12)}-`

      const names = yield* Effect
        .promise(() => readdir(path.join(electron.app.getPath("userData"), "Partitions")))
        .pipe(Effect.catch(() => Effect.succeed<string[]>([])))

      for (const name of names) {
        if (!name.startsWith(prefix)) continue
        const decoded = Schema.decodeUnknownOption(SessionID)(name.slice(prefix.length))

        if (Option.isNone(decoded)) continue

        const partition = `persist:${name}`

        if (Array.from(entries.values()).some((entry) => entry.partition === partition)) continue

        const gone = yield* get(decoded.value).pipe(
          Effect.as(false),
          Effect.catchIf(
            (error) => Predicate.isTagged(error, "SessionNotFoundError"),
            () => Effect.succeed(true),
          ),
        )

        if (gone) purge(server, name.slice(prefix.length))
      }
    })
  }

  async function closePage(entry: Entry, tabID: Browser.TabID, error?: string) {
    const page = entry.pages.get(tabID)

    if (!entry.tabs.has(tabID))
      throw new Error(
        "This tab is no longer available. Call browser.tabs.list({}) and use an existing tabID from this session.",
      )
    const focused = entry.focusedTabID === tabID
    entry.requests.forEach((request) => {
      if (request.tabID === tabID) request.abort.abort()
    })
    entry.pages.delete(tabID)
    entry.tabs.delete(tabID)
    entry.scrolls.delete(tabID)

    if (focused) entry.focusedTabID = entry.tabs.keys().next().value ?? null

    if (page) await release(page)
    publishState(entry, error)
  }

  function release(page: BrowserPage) {
    const done = page.dispose()
    const settled = done.catch(() => undefined)
    releasing.add(settled)
    void settled.finally(() => releasing.delete(settled))

    return done
  }

  function publishState(entry: Entry, error?: string) {
    const current = { type: "state" as const, state: inventory(entry) }
    const event = error === undefined ? current : { ...current, error }

    // Teardown publishes an empty inventory to the renderer, but the saved URLs survive app exit.
    if (entry.report)
      restore.save(entry.storageKey, {
        tabs: event.state.tabs.map((tab) => {
          const scroll = entry.scrolls.get(tab.id)

          const stored = {
            id: tab.id,
            // A restored page can publish before Chromium assigns its URL.
            url: tab.url || entry.tabs.get(tab.id)?.url || "about:blank",
          }

          if (scroll) {
            if (scroll.inner?.length) return { ...stored, scrollX: scroll.x, scrollY: scroll.y, scrollInner: scroll.inner }

            return { ...stored, scrollX: scroll.x, scrollY: scroll.y }
          }

          return stored
        }),
        focusedTabID: entry.focusedTabID,
      })
    const next = JSON.stringify(event)

    if (entry.lastState === next) return
    entry.lastState = next
    report(entry, event)
  }

  function report(entry: Entry, event: PaneEvent) {
    if (entry.report) return entry.report(event)
    publish(entry, event)
  }

  function inventory(entry: Entry): Browser.State {
    return {
      tabs: Array.from(entry.tabs, ([id, tab]) => entry.pages.get(id)?.state() ?? tab),
      focusedTabID: entry.focusedTabID,
    }
  }

  function load(entry: Entry, tabID: Browser.TabID) {
    const page = entry.pages.get(tabID)

    if (page) return page
    const tab = entry.tabs.get(tabID)

    return tab ? create(entry, true, undefined, tab) : undefined
  }

  function create(
    entry: Entry,
    initialize = true,
    popupOptions?: Electron.BrowserWindowConstructorOptions,
    restore?: Browser.Tab,
  ) {
    if (!entry.network) throw new Error("Browser network is not ready; no tab was opened.")
    const id = restore?.id ?? Browser.TabID.make(`tab_${crypto.randomUUID()}`)

    const fail = () => {
      if (entry.pages.has(id)) void closePage(entry, id, "page_crashed").catch(() => undefined)
    }

    const page = createBrowserPage(entry.win, {
      id,
      partition: entry.partition,
      network: entry.network,
      initialize,
      restore,
      popupOptions,
      fileRoots: () => entry.fileRoots,
      shared,
      embeds: input.embeds,
      fail,
      scrolled: (position) => {
        // A zero read forgets the tab: it navigated, and the new document's own scroll will replace it.
        if (position.x || position.y || position.inner?.length) entry.scrolls.set(id, position)
        else entry.scrolls.delete(id)
      },
      restoreScroll: initialize ? entry.scrolls.get(id) : undefined,
      publish: (error) => {
        if (entry.pages.has(id)) publishState(entry, error)
      },
      inspect: (event) => {
        if (entry.pages.has(id)) report(entry, { type: "inspect", tabID: id, ...event })
      },
      // Icons and zoom are local to this desktop, and follow the states reported before them, so the window files a new
      // page's icon under that page's URL.
      detail: (value) => {
        if (entry.pages.has(id)) report(entry, { type: "page", tabID: id, ...value })
      },
      zoomed: () => entry.pages.forEach((page) => page.detail()),
      shortcut: (shortcut) => {
        if (!entry.pages.has(id) || entry.focusedTabID !== id || entry.win.isDestroyed()) return

        // The page held keyboard focus; the command runs in the app, which may move focus there, as ⌘L does.
        if (entry.win.isFocused()) entry.win.webContents.focus()
        publish(entry, { type: "shortcut", ...shortcut })
      },
      focused: () => {
        if (entry.pages.has(id) && entry.focusedTabID === id) publish(entry, { type: "focused", tabID: id })
      },
      popup: (popupOptions, background) => {
        const popup = create(entry, false, popupOptions)

        if (!background) focus(entry, popup.state().id)

        return popup.contents
      },
    })

    entry.pages.set(id, page)
    entry.tabs.set(id, restore ?? page.state())
    // Straight to the window, not through the server report: the embed is local to this desktop.
    publish(entry, { type: "embed", tabID: id, embed: page.embed })
    void page.ready
      .then(() => {
        if (entry.pages.get(id) === page) publishState(entry)
      })
      .catch(fail)

    return page
  }

  async function execute(entry: Entry, command: Browser.Command, signal: AbortSignal) {
    const action = command.action

    if (signal.aborted)
      throw new Error(
        "Browser request was cancelled. Do not repeat a mutating action until you have inspected its outcome.",
      )

    if (action.type === "tabs.list") return { value: inventory(entry), files: [] }

    if (action.type === "preview") {
      // The renderer owns file tabs; it resolves the path against the session's workspace.
      report(entry, { type: "preview", path: action.path })

      return { value: { path: action.path }, files: [] }
    }

    if (action.type === "tabs.open") {
      const page = create(entry)

      if (action.focus !== false) focus(entry, page.state().id)
      await page.ready

      // A new page already loads about:blank, so only another address needs a navigation.
      if (action.url !== undefined)
        await page.execute({ action: { type: "navigate", tabID: page.state().id, url: action.url }, files: [] }, signal)
      publishState(entry)

      return { value: page.state(), files: [] }
    }

    // The cookie jar belongs to the partition, not a document: no tab, no generation check.
    if (isCookieAction(action)) return { value: await runCookieCommand(entry.partition, action), files: [] }

    const tab = inventory(entry).tabs.find((tab) => tab.id === action.tabID)

    if (!tab)
      throw new Error(
        "Browser tab is unavailable. Call browser.tabs.list({}) and use an existing tabID from this session; a closed tab is not replaced automatically.",
      )

    if (action.type === "tabs.focus") {
      focus(entry, action.tabID)

      return { value: tab, files: [] }
    }

    if (action.type === "tabs.close") {
      await closePage(entry, action.tabID)

      return { value: inventory(entry), files: [] }
    }

    const page = entry.pages.get(action.tabID) ?? create(entry, true, undefined, tab)
    await page.ready
    const result = await page.execute(command, signal)
    publishState(entry)

    return result
  }

  function focus(entry: Entry, tabID: Browser.TabID) {
    // The outgoing page's scroll goes on the tab's record before the switch is stored.
    if (entry.focusedTabID && entry.focusedTabID !== tabID) entry.pages.get(entry.focusedTabID)?.captureScroll()
    entry.focusedTabID = tabID
    publishState(entry)
    report(entry, { type: "focus", tabID })
  }

  function isCookieAction(action: Browser.Action): action is CookieAction {
    return (
      action.type === "cookies.list" ||
      action.type === "cookies.get" ||
      action.type === "cookies.set" ||
      action.type === "cookies.delete" ||
      action.type === "cookies.prune" ||
      action.type === "cookies.export" ||
      action.type === "cookies.import"
    )
  }
}
