# Mobile Compatibility Matrix — Server 0.0.0-dev-21792

Probed live on the Windows dev service (2026-10-26): `/openapi.json` (124 paths) plus a live SSE sample. The MacBook runs the same pinned CLI, so the matrix applies to both hosts. `mobile` = needed by the phone app, `bridge` = needed by the GX10 notifier.

## Identity and pairing

| Need | Endpoint | Verified shape |
| --- | --- | --- |
| Server identity | `GET /api/info` | `{version, pid, urls[], paths, capabilities}` — use `version` for the compatibility gate |
| Mint pairing code | `POST /api/pair` (mobile+bridge) | `{code, expires_in}` |
| Redeem code | `GET /auth/connect/{code}` (mobile+bridge) | `{token}` — long-lived session token; no security scheme is documented in OpenAPI, so confirm token placement (header) when first wired |

Authentication observed locally is HTTP Basic against the registration password; remote hosts authenticate with the paired token. Treat the wire auth details as the first integration test, not settled fact.

## Projects and locations

| Need | Endpoint | Notes |
| --- | --- | --- |
| Project list | `GET /api/project?archived=` | `Project[]`: `id, canonical, vcs, name, icon, commands, time, sandboxes` |
| Location object | `GET /api/location?location={directory}` | Locations are addressed by absolute `directory` — every location-scoped call takes a `location` query. Phone/host keys are therefore `(hostID, directory, resourceID)`, as ARCHITECTURE.md planned |
| FS listing | `GET /api/fs/list?location&path` | `{location, data: [{path: RelativePath, type: file|directory}]}` — project file browser is directly supported |
| FS search | `GET /api/fs/find` | exists; parameters unverified |
| **File read** | `GET /api/fs/read/*?location` | Responds `application/octet-stream` — raw bytes, not JSON. The reader must decode bytes (UTF-8 default), detect binary, and enforce its own size cap; no server-side truncation contract found |

## Sessions

| Need | Endpoint | Notes |
| --- | --- | --- |
| List | `GET /api/session` | filters: `limit, order, search, parentID, archived, directory, project, subpath, cursor`; cursor-paginated |
| Session fields | `Session.Info` | `id, parentID, projectID, agent, model, cost, tokens, outcome, time, title, subpath, permissions, revert, location` — status derives from `time`/`outcome` + active map, not a single `status` field |
| Active runs | `GET /api/session/active` | `{data: {<ses_…>: {type:"running"}}}` — the cheap liveness check for overview and bridge polling |
| History | `GET /api/session/{id}/message` | cursor-paginated `{previous, next}`; message is a `oneOf` union — UI must dispatch per message type |
| Prompt | `POST /api/session/{id}/prompt` | `{id?, text, files[], agents[], skills[], metadata, delivery?, resume?}`; file attachments supported |
| Stop | `POST /api/session/{id}/interrupt?resume=true|false` | resume variant available |
| Diff view | `GET /api/session/{id}/diff?from=` | per-turn diff against a user message — feeds the "changed files" view |
| Questions/forms | `GET /api/session/{id}/form`, `POST …/form/{formID}/reply` | agent question flow exists |
| Permission requests | `GET /api/permission/request?location` | `Permission.Request`: `id, sessionID, action, resources[], save[], source, message` |
| Permission reply | `POST /api/session/{id}/permission/{requestID}/reply` | `{decision, message?}` → 204 |

## Events (`GET /api/event`)

SSE, `text/event-stream`, envelope `{id?, type, data}` — **the live field is `type`; the OpenAPI names it `event`. Trust the wire, log both.** Live-observed names during ordinary agent work:

```text
server.connected
session.reasoning.delta / session.reasoning.ended
session.step.streamed / session.step.ended
session.tool.input.started / .input.ended / .called / .progress / .success
session.usage.updated
shell.created / shell.exited / shell.deleted
```

Not yet observed live (must appear when triggered): failure/error events, permission-request events, form-created events, session-idle/completion markers. Mobile consumes events only while foregrounded. The bridge combines streams with **reconcile-by-poll** (`session/active` + `/api/permission/request` snapshots) so completion and approval detection do not depend on catching an exact event — this closes the "live-only, no replay" gap.

## Confirmed capabilities summary

- Pairing, projects, locations, session CRUD-ish set, prompts, interrupt, permission replies, forms, diff, file list/read: **all present on the installed server**.
- Terminal/persistent-pty, voice, worktree, revert, MCP management endpoints exist but are out of mobile scope.
- Gaps to design around: raw-byte file reads (client-side size/binary handling), status derivation rather than a status field, undocumented auth headers, and event names for completion/failure/approval pending a trigger-driven live test.

## Consequences for implementation

1. Expo app can be built against `@opencode/client`-style REST + SSE with host-scoped base URLs; no bespoke protocol needed.
2. Notification bridge needs no OpenCode source changes: events + `session/active` + permission polling are sufficient.
3. First integration test on a real phone: pairing redeem → `/api/info` version check → one session's stream. Any auth-header surprise is contained in the transport adapter only.
