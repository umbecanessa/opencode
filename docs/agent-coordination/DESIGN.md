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
yet (the API flag is ready for it), no migration of legacy hidden utility
sessions onto the flag, no configurable retention.

## Phase 3 — Awareness

- opencode skill: "Session coordination" section covering all tools above
  (V2 docs only).
- config schema: `session` permission action documented; `temporary` field and
  `servers` (Phase 4) added when they land.
- `bun run generate` in `packages/client` after protocol changes.

## Phase 4 — Peer servers (bridging)

Config gains server-side `servers: { name: { url, credential } }`.
`session_spawn` / `session_list` accept `server?: string` and route to the
peer's own HTTP API — zero new protocol surface, since `session.create`,
`session.prompt`, `session.interrupt`, `session.wait` all already exist
remotely. The desktop app syncs its SSH/WSL-registered servers into this
config (the only genuinely new wire). New permission action `server`, default
deny. Caveat documented in tool text: a dispatched remote session with no
attached client has nowhere to surface permission asks; pre-approve in the
remote project or keep a client attached.

## Phase 5 — Placement (clustering endpoint)

`Location` gains a server dimension; `SessionExecution` routes drains through
`LocationServiceMap` to remote-owned claims; a real `ssh` `WorkspaceDriver`
registers into the currently empty registry. This is the only phase with
genuinely new semantics (remote claims, fencing, interruption targeting) and
it waits until Phase 4's failure modes are understood. At that point
`subagent`/`session_spawn` grow a placement argument and inherit cross-machine
reach for free.
