# OpenCode Mobile — Product Requirements

Status: agreed direction; implementation not started.

## Repository and scope

Build inside the personal `umbecanessa/opencode` fork, alongside the existing desktop app. Do not create a separate repository or disturb the installed desktop apps. Proposed packages: `packages/mobile` and `packages/notification-bridge`. Package names and workspace integration must be checked before scaffolding.

## Purpose

Give the owner one iPhone interface for monitoring and controlling agents on Windows and MacBook over Tailscale. Sessions remain on their execution host: no copied conversations, file synchronization, or agent runtime on the phone.

## Confirmed platform decisions

- React Native with Expo development builds; iPhone first.
- Mac Mini for iOS compilation and signing.
- OneSignal for remote notifications, backed by Apple APNs.
- A single small notification bridge on the always-on GX10, separate from vLLM.
- Both OpenCode hosts and the phone use Tailscale.
- Clean, modern, native-feeling UI; readable files are a core workflow, not an attachment afterthought.

## Main workflows

1. Pair the phone independently with each host using its pairing link or QR code.
2. See combined activity, with unmistakable host and project context.
3. Browse projects on either host and open their sessions.
4. Read streaming output, send follow-ups, answer questions, respond to permission requests, and stop a run.
5. Browse project files or tap a file reference in a conversation.
6. Read Markdown in an upward-opening sheet; expand to full screen and dismiss back to the original conversation position.
7. Receive an actionable notification when a run completes, fails, or needs input; tap to open its exact host/session.

## Information architecture

- **Activity:** running, needs attention, completed, failed; filter by host.
- **Projects:** host-grouped project list, project sessions and files.
- **Hosts:** pairing, connectivity, credential renewal, notification preferences.
- **Session:** conversation, tool activity, composer, contextual file access.
- **Reader:** modal sheet over the current screen, not a navigation reset.

## Functional requirements

### Identity and connection
- Every project/session/file key includes host identity. Identical paths on different hosts never merge.
- Host availability is distinct from session execution state.
- Show connection loss and stale data explicitly; reconnect and refresh authoritative state.
- Store phone credentials in platform secure storage. Provide removal and re-pairing.

### Sessions and controls
- Support paginated history and streaming without forcing scroll-to-bottom when the user is reading earlier messages.
- Keep host/project context visible before sending or approving anything.
- Do not optimistically claim a command succeeded before server acknowledgement.
- Display API errors with retry paths; unsupported capabilities are explicitly unavailable.

### Projects and files
- Project view includes sessions and a navigable file list.
- Resolve references against their originating host and session location, including line references where available.
- Markdown reader supports headings, lists, tables, code blocks and links, plus Rendered/Source modes.
- Code/text reader supports syntax highlighting and referenced-line navigation where practical.
- Show filename, project-relative path, host, loading/error states and current-versus-historical content context.
- Internal links resolve safely within the project; external URLs use a separate external-link action.
- Do not render executable HTML, embedded scripts or automatically fetched remote Markdown assets.
- Missing, oversized and binary files receive explicit states. Initial release is read-only for files.

### Notifications
- Completion, failure, approval and question events; per-host preferences.
- Generic content by default; no source code, prompts or secrets in push payloads.
- Opaque routing identifiers open the correct session after authentication.
- Deduplicate alerts across reconnects and bridge restarts.
- Network loss alone must not generate a failed-agent notification.
- Missed events may not be reconstructible; never promise exact delivery from live-only events.

## UX quality bar

Operate mode for management screens; Read mode for the file reader. Restrained surfaces, strong typography, clear hierarchy, compact useful lists rather than a grid of decorative cards. Support light/dark appearance, safe areas, Dynamic Type, VoiceOver labels, reduced motion and comfortable touch targets. Status must not rely on color alone. Bottom sheets need accessible close/expand controls, not gestures alone. Final visual tokens and screen compositions are a design milestone, not yet approved specifications.

## Non-goals for initial release

- Public multi-user SaaS, billing or public internet exposure.
- Running models/agents on iOS or proxying their traffic through GX10.
- File editing, terminal emulation, repository synchronization or replacing desktop OpenCode.
- Reliable background event-stream connections from iOS.
- Changes to vLLM, desktop service bindings or the working CLI pin.

## Acceptance scenarios

- Pair both hosts; each project and session is clearly attributed.
- Send a prompt from iPhone; the existing desktop/MacBook session reflects the same interaction.
- Open a Markdown reference, expand the reader, then dismiss without losing conversation scroll position.
- Open the same project-relative filename on both hosts and receive the correct contents.
- Disconnect Tailscale; stale data is labelled and writes fail visibly. Restore it and refresh state.
- Receive a locked-phone notification and deep-link to the correct session over Tailscale.
- Restart the bridge without resending previously recorded alerts.
- Put MacBook to sleep; show it offline without inventing a run failure.

## Delivery milestones

1. **Compatibility spike:** inspect installed host API contracts, pairing, events, projects, files and run status. Record actual supported operations and fixtures without secrets.
2. **Read-only vertical slice:** Expo app, independent pairing, host/project/session navigation, live activity and Markdown sheet.
3. **Control:** prompts, stop, questions and permissions; integration tests against supported hosts.
4. **Notifications:** GX10 bridge, persistence, OneSignal, native configuration and deep links.
5. **Device validation:** build on Mini, test physical iPhone, accessibility, network recovery and distribution.

## Open decisions / external dependencies

Apple Developer membership, APNs credentials, OneSignal app credentials, iPhone/iOS test target and distribution method remain unconfirmed. Exact Expo/library versions, event mappings and file APIs require validation against the installed CLI (`0.0.0-dev-21792` at planning time). No shipping or notification-delivery claims until physical-device validation.
