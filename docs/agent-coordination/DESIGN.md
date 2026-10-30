# Agent Coordination

Design for giving orchestrating agents first-class coordination over other sessions:
peer sessions, spawned main agents, completion notifications, temporary sessions,
and (later) remote placement. This is the program of record; each phase ships
independently and stays useful on its own.

## Principles

1. **Sessions are the only unit of work.** Every coordination target — subagent
   child, peer main agent, temporary session, remote session — is a `Session`
   with different attributes, never a new entity type. Durable prompt admission,
   inbox delivery (steer/queue), wake semantics, and completion notifications
   stay shared across all of them.
2. **Layering stays honest.** Schema → Core → Protocol → Server. Tool plugins
   live in `packages/core/src/tool/plugin/`. Protocol/Server changes require
   `bun run generate` in `packages/client`.
3. **Capabilities ship with model-facing discoverability.** Every capability
   needs a tool with a description that states when *not* to use it, plus
   opencode-skill and config-schema coverage. A capability the model cannot see
   does not exist.

## Capability matrix (baseline)

| Capability | Agent tools | API / client |
| --- | --- | --- |
| Subagent with model/agent/background selection | yes (`subagent`) | yes |
| Park subagent, notified completion, continue by `sessionID` | yes | yes |
| Steer running subagent | yes | yes |
| Interrupt a subagent from the model | no (cascade only) | yes (`session.interrupt`) |
| Prompt/interrupt peer level-zero sessions | no | yes |
| Create a session in another project directory | indirect (`session_move`) | yes (`session.create` + `location`) |
| Dispatch to another OpenCode server | no | client-side only (server registry) |
| Server-native remote placement | no (reserved: `Location.workspaceID`, empty `WorkspaceDriver` registry) | no |

## Phase 1 — Model-side session coordination tools (implemented here)

New built-in tool plugin `core/src/tool/plugin/session.ts`, namespace `opencode`
(so effective names are `opencode_session_*`, `codemode: false` so they stay on
the provider's native tool list like `subagent`, filterable via the new
`session` permission action):

- `session_list` — recent sessions with `active`/`outcome`/`directory`.
- `session_spawn` — create a **top-level** session (any agent, optional
  `model` override, optional `directory` for cross-project work) and run a
  prompt in it. Foreground blocks via `Job.block` (the user can still push it
  to background); `background: true` follows the exact background-subagent
  pattern: `prompt(resume: false)` → owned job run wakes it → completion
  delivered as a `<peer sessionID=... state=...>` synthetic part.
- `session_send` — follow-up prompt to any known session; `delivery: steer|queue`,
  `resume` pass-through. No completion notification (documented).
- `session_stop` — `session.interrupt`; parked history stays continuable via
  `session_send`.
- `session_wait` — bounded join with `idle` + `outcome`.

Plumbing reused, not duplicated:

- `Job.Recovery` gains `kind: "peer"` (structurally identical to `subagent`;
  no parent link required by restart recovery, which is guarded on kind in
  `session/execution/restart.ts`).
- `SubagentJob` and `SubagentCompletion` accept both kinds; the synthetic
  completion tag follows the kind (`<peer>` vs `<subagent>`), and
  `metadata.source` now carries the recovery kind.
- Peer jobs are recoverable across restarts exactly like background subagents:
  persisted background markers are re-observed and the parent gets its notice.

Permissions: a single `session` action. Default with no rule is `ask`
(`Permission.evaluate` default), so the first peer coordination per resource
prompts the user. Built-in `subagent`-mode agents (`general`, `explore`) get an
explicit `session` deny — peer coordination is an orchestrator-level capability,
matching how `subagent` itself is denied to subagents. Catalog filtering via the
registration `permission` option hides the tools entirely when denied.

Deliberate non-goals of Phase 1: no temporary sessions (Phase 2), no per-server
dispatch (Phase 4), no completion notification for `session_send` continuations
of already-finished peers, no `subagent_depth` change, and no cross-server
discovery tool.

## Phase 2 — Temporary sessions (implemented here)

`temporary: boolean` is a first-class field on `Session.Info`, the durable
`session.created` event, and `SessionTable` (migration
`add_temporary_sessions`). A temporary session behaves identically while alive
(promptable, continuable, waitable) but is:

- **Listed only on request**: every `session.list` path (service, store, HTTP
  query parameter, list cursors carry it) omits temporary sessions unless
  `temporary: true` is passed, which then returns *only* temporary sessions.
  This covers the desktop/TUI session lists for free — no client changes needed
  to keep disposable work out of history.
- **Created via any face**: `session.create` API payload, plugin host
  `session.create`, and `opencode_session_spawn` with `temporary: true`
  (also surfaced on `opencode_session_list`).
- **Permission-preset stricter**: unless the caller supplies explicit
  permissions, a temporary session gets `deny` rules for `edit`, `subagent`,
  and `session` on top of its agent's rules. It can read and search but cannot
  fan out or touch the workspace.
- **Garbage-collected without live timers**: `Session.reapTemporary` hard-deletes
  (via the ordinary `Session.remove` cascade: events, projections, transcripts)
  temporary sessions that are terminal-idle past a 24-hour retention window,
  plus never-idled ones holding no execution claim (running ones are protected
  by their claim). It runs opportunistically whenever a new temporary session
  is created, and at boot the restart sweep first releases temporary claims
  (disposable work is never resumed) and then reaps. Peer jobs observing a
  reclaimed child complete silently through the existing vanished-child path.
- **Expiry is honest to the model**: `session_send` tool text documents that a
  missing session may be an expired temporary one and to spawn a fresh session
  with the needed context instead.

Deliberate Phase 2 non-goals: no desktop/TUI "New temporary session" button
yet (the API flag is ready for it; the app/desktop entry landed later, see the
Phase 4b note), no migration of legacy hidden utility sessions onto the flag,
no configurable retention.

## Phase 3 — Awareness (skill done here)

- The built-in opencode skill (`core/src/plugin/skill/opencode.md`, imported
  as text and registered with the built-in skills) gained a self-contained
  "Session coordination" section: the five tools, when to prefer `subagent`,
  background/`<peer>` notification discipline, temporary-session semantics
  including expiry, the `session` permission action with a config example,
  and the subagent-mode deny.
- Config schema needs no change: `Permission.Rule.action` is an open string,
  and both the native `permissions` array and the V1-style `permission` map
  already accept `session` keys, so `permission: { session: ... }` flows
  through `Config.normalize` unchanged.
- Remaining for this phase: the prose pages in the V2 docs site, which lives
  in the separate `services/www` repository (the skill refers to it via
  `opencode.ai/v2/docs` links). The TUI temporary-session button is dropped
  by decision: the TUI is not used here, and the desktop/app entry is
  implemented (see the Phase 4b note).
- `bun run generate` in `packages/client` was run for the Phase 2 protocol
  additions; rerun it after any future Protocol/Server HttpApi change.

## Phase 4 — Peer servers (bridging) (implemented here)

Config gains server-side `servers: { name: { url, credential } }`
(`packages/schema/src/config/server.ts`, `Config.Server`; passed through
`Config.normalize`). All five `session_*` tools accept `server?: string` and
route to the peer's own HTTP API through the new Location-scoped
`PeerServers` core service (`packages/core/src/peer-servers.ts`) — zero new
protocol surface, since `session.list`, `session.create`, `session.prompt`,
`session.interrupt`, `session.wait`, `session.active`, `session.context`, and
`session.inbox.list` all already exist remotely. Auth is HTTP Basic with
username `opencode` and the config `credential` as password
(`packages/server/src/auth.ts`). New permission action `server`, resource is
the server name, default ask; remote branches skip the local `session`
asserts. Remote `session.wait` resolves instantly when a run has not started
yet, so the spawn/wait paths run a settle loop (re-check `session.active` and
`session.inbox.list` after every wait) instead of trusting one wait.
Dispatched sessions are foreground-only (`background` and `directory` are
rejected with explicit failures). Caveat documented in skill and tool text:
a dispatched remote session with no attached client has nowhere to surface
permission asks; pre-approve in the remote project or keep a client attached.
Covered by `packages/core/test/tool-session-remote.test.ts` (stubbed
`PeerServers` routing) plus the existing local tool suite.

Remaining for this phase: the V2 docs prose in `services/www`.

### Desktop registration (implemented here)

The last Phase 4 wire: the desktop app pushes its ready remote servers into the
sidecar's runtime registry so the session tools see the same SSH/WSL tunnels
the user sees. New in-memory global core service `PeerServers.Registry`
(`@opencode/PeerServers/Registry`), resolved by `PeerServers.target` after the
config map (a config key of the same name always wins); unknown names list
both sources. Protocol gains exactly one endpoint,
`PUT /api/experimental/peer-servers` (payload `{ servers }`, whole-map
replace), handled by the session group with no location middleware; the
registry node joins `applicationServiceNodes` in `server/src/routes.ts`.
Desktop side: `main/service/peer-servers.ts` retains the union of
renderer-reported endpoints (`PluginConfigure`) and PUTs
`{ <ServerConnection key>: { url, credential } }` — keyed `ssh:<id>`,
`wsl:<distro>`, or the manual URL — skipping the sidecar's own origin;
re-pushed from `BackgroundService.connect` so a reconnect with a new password
re-registers. The session-tools system hook now lists the live names from
`PeerServers.names()` when any exist. Nothing persists: a server restart
forgets registrations until the desktop re-pushes.

### Temporary session entry (implemented here)

The Phase 2 non-goal, wired into the app/desktop UI. The draft tab schema gains
an optional `temporary` flag; `openNewTab(temporary)` (titlebar) threads it
into `tabs.newDraft`, and the new-session composer adapter passes it to
`data.session.create` at first prompt (read before `prepareSession` swaps the
draft tab away). Entry points: command-palette command `tab.newTemporary`
(owner-exported `newTemporaryTabCommand`, kept honest by the desktop-menu
ownership test) and the desktop File menu item "New Temporary Session"
(no accelerator; Cmd+Shift+N stays with New Window). While the draft is open
the view shows a subtle "Temporary session" badge whose tooltip explains the
disposable semantics. `client/src/solid/data.ts` `session.create` accepts
`temporary` and forwards it through the existing payload spread; listings
already exclude temporary sessions server-side, so the session appears nowhere
but its own tab once the tab closes.

## Phase 5 — Placement (clustering endpoint)

`Location` gains a server dimension; `SessionExecution` routes drains through
`LocationServiceMap` to remote-owned claims; a real `ssh` `WorkspaceDriver`
registers into the currently empty registry. This is the only phase with
genuinely new semantics (remote claims, fencing, interruption targeting) and
it waits until Phase 4's failure modes are understood. At that point
`subagent`/`session_spawn` grow a placement argument and inherit cross-machine
reach for free.
