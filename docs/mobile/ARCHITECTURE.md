# OpenCode Mobile — Architecture

Status: proposed implementation architecture; validate protocol assumptions before coding.

## Topology

```text
iPhone (Expo / React Native)
  |-- Tailscale + paired credential --> Windows OpenCode service
  |-- Tailscale + paired credential --> MacBook OpenCode service
  |
  <-- APNs <-- OneSignal <-- GX10 notification bridge
                                |-- Tailscale --> Windows events/status
                                |-- Tailscale --> MacBook events/status

Mac Mini: native iOS build/signing only
```

Phone requests for conversations, files and controls go directly to the relevant host. GX10 is a notification observer, not an OpenCode proxy or execution host. No new public inbound listener is required for the bridge. OneSignal registration and payload routing need a deliberate enrollment design; never ship an unauthenticated public enrollment endpoint.

## Repository boundaries

- `mobile/app` (created): Expo application, navigation, secure credential storage, API adapters, view state and reader. Kept outside the workspace globs so its React Native tree never enters desktop/CLI builds; it has its own package.json and npm install.
- `mobile/bridge` (planned): headless TypeScript service, independent host watchers, notification delivery and durable ledger.
- Reuse the existing generated client where compatible with React Native and installed hosts. Do not import server/core runtimes into mobile or edit generated clients by hand.
- Introduce a shared package only when actual duplicated contracts justify it. Keep secrets and machine-specific deployment config outside version control.
- This documentation lives under `docs/mobile` so it does not redefine product/design authority for the existing desktop app.

## Compatibility gate

Inspect each host's served OpenAPI and authentication flow read-only using its configured authenticated context. Compare with this checkout's client; do not assume latest documentation matches the pinned binary. Verify React Native streaming support, secure storage, file responses and pairing redemption before choosing adapters. Never invoke implicit local service management from the phone or bridge. Neither should upgrade, replace or restart host services.

Create a capability matrix covering server identity/version, pairing, projects/locations, sessions/history, stream events, prompts, cancellation, questions, approvals, file list/read and diff access. Unsupported operations degrade visibly. Pin working dependencies and document tested server versions.

## Mobile application

Maintain a stable local host ID, display name, endpoint and secure credential reference. All remote cache keys are `(hostID, location, resourceID)` as appropriate. Persist only minimal metadata initially; transcript and file caching is optional and must have an explicit privacy policy.

Use a host-scoped transport/adapter boundary, keeping wire details out of screens. Subscribe only while the app is active; cancel and reconnect deliberately. After foregrounding or stream failure, refresh authoritative state before declaring it current. Current documented event streams are live-only, so reconnect is not replay.

Actions carry explicit originating host and location. Disable duplicate submissions while awaiting acknowledgement. On uncertain network outcomes, refresh before offering an action retry that might duplicate work.

## Reader

Represent file targets as structured host, location, path and optional line information. Prefer structured server references over text detection. Text links need conservative parsing and project-aware resolution. Server-side authorization remains authoritative; UI path normalization is not a security boundary.

Present a native bottom sheet with partial/full-height states, accessible controls and preserved underlying navigation/scroll state. Render Markdown without raw executable HTML. Do not automatically load remote images or execute URL schemes. Distinguish current file content from historical patch/snapshot content. Set explicit size limits after measuring server responses; provide a clear truncated/unsupported state rather than freezing the UI.

## Bridge

Run one supervised instance on GX10, using the existing deployment convention after inspection. Keep it isolated from vLLM and bound resource usage. A small persistent database records host watcher checkpoints, notification deduplication and delivery attempts; SQLite is the initial proposal.

Each host has separate bridge credentials. Confirm whether restricted tokens exist; if pairing grants broad access, document that security exposure rather than claiming read-only authorization.

Per host: connect, take a status snapshot, consume verified events, normalize relevant transitions, record an outbox entry, then deliver through OneSignal. Reconnect with bounded backoff and jitter. Host offline is not session failed. After reconnect, compare authoritative status with persisted observations; only emit recoverable transitions, without inventing exact completion times or claiming all missed approvals can be recovered.

Use stable event/run identity when available; define deduplication from the verified protocol before implementation. Persist delivery results. External delivery timeouts can leave uncertain outcomes: use provider idempotency support if available and document residual duplicate risk. OneSignal accepting a request is not proof the iPhone displayed it.

## Notification identity and routing

Bind the intended OneSignal subscription to this personal installation through an explicit enrollment step. Persist only needed routing metadata; keep OneSignal sending credentials on GX10. Payloads contain generic text and opaque host/session routing IDs, not host passwords or file contents. On tap, resolve IDs through the phone's paired host registry; missing/expired credentials lead to re-pairing, offline hosts to a clear unavailable state.

Apple signing, APNs setup and native OneSignal integration are required. Use an Expo development build rather than Expo Go. Test locked-device receipt and navigation separately from foreground alerts. Tailscale must be available for opening protected content, even when push itself arrives via Apple.

## Security and operations

- Tailscale-only service access; no broad firewall changes as an implementation shortcut.
- iOS Keychain-backed secure storage; protected bridge config files/environment injection.
- Redact pairing links, bearer tokens, authorization headers and user content from logs and fixtures.
- Treat repository files and Markdown as untrusted content.
- Structured logs for host connectivity, reconnects, outbox failures and last successful observation, without transcripts.
- Back up the bridge ledger/config securely; document credential revocation and device removal.
- A sleeping/offline execution host cannot continue normal agent work; GX10 does not change this.

## Verification and rollout

Unit-test host-scoped keys, reference resolution, transition filtering and deduplication. Contract-test adapters with sanitized fixtures from the installed APIs. Integration-test two hosts, token expiry, disconnect/reconnect and bridge restart. Validate stream behavior and sheet accessibility on a physical iPhone. Test completion, failure, approval and question pushes end-to-end while locked. Build/sign on Mini only after enrollment prerequisites are available.

First implementation task: compatibility spike, followed by the read-only vertical slice from the PRD. Do not deploy the bridge or modify running OpenCode/vLLM services as part of scaffolding.
