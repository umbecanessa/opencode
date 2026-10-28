# Mobile notification bridge

Runs independently of OpenCode and vLLM. No inbound listener. **Not deployed or push-validated yet.**

## Private setup

Create `config.json` (ignored by git) with:

```json
{"hosts":[{"id":"PHONE_HOST_ID","origin":"http://TAILSCALE_IP:28894","tokenEnv":"DESKTOP_TOKEN","subscriptions":["ONESIGNAL_SUBSCRIPTION_ID"],"events":["completed","failed","approval","question"]}]}
```

Host IDs must match the phone's paired registry. Enroll only your phone's exact OneSignal subscription ID; there is no public enrollment endpoint or all-subscribers broadcast. Each host's `events` list controls preferences. Use separate bridge pairing credentials, not the phone credential. These credentials grant broad server access, not enforced read-only access.

Optional per-host `"previews": true` enables session titles, agent/status subtitles, and up to 220 characters of the final assistant text for completion/failure alerts. Default is generic. Previews go through OneSignal/APNs and may appear on the lock screen; they may contain sensitive assistant text despite code blocks and link targets being omitted. Tool output, reasoning, and file contents are not read for previews. Set `previews` to false and restart to restore generic alerts. Existing queued notifications retain their original content.

Set `ONESIGNAL_APP_ID`, `ONESIGNAL_API_KEY`, and each host's credential variable in a private `.env` file; protect directory and files with owner-only permissions. Never commit or paste credentials into chat. Run `bun install`, then `bun start`. Persist `bridge.sqlite` and its WAL beside the config. Run one supervised process only. Do not expose this directory through a web server.

## Delivery guarantees and limits

SQLite seen/outbox records survive restarts. Retries reuse OneSignal idempotency keys. Provider acceptance is not confirmation that the phone displayed the alert. First observation baselines old completions but alerts on outstanding questions/permissions. Offline hosts do not become failed agents. Polling observes the latest 100 sessions and active-session requests; short-lived requests and older changes can be missed. Interrupted/cancelled runs are not failure notifications. Host credentials and content are excluded from logs/payloads.

Before deployment: verify outcome shapes against each host, enroll the phone, configure APNs and iOS OneSignal SDK, test locked-phone delivery and routing, restart dedupe, token expiry, and host sleep/recovery. Disable a host by removing it from config and restarting; revoke its bridge credential on the host. Retain the database to avoid replaying notifications.

## GX10 user service

The service file expects code at `~/services/opencode-mobile-bridge`, private config at `~/.config/opencode-mobile-bridge/config.json`, credentials at `~/.config/opencode-mobile-bridge/bridge.env`, and state at `~/.local/state/opencode-mobile-bridge`. The unit is staged but must not be started before credentials and exact subscription enrollment are configured.

Edit the environment file directly on GX10 (never through a chat message):

```sh
umask 077
nano ~/.config/opencode-mobile-bridge/bridge.env
```

Required entries:

```dotenv
ONESIGNAL_APP_ID=198438f5-2341-421a-adcf-1891a4e0ba39
ONESIGNAL_API_KEY=REPLACEMENT_PRIVATE_APP_KEY
DESKTOP_TOKEN=SEPARATELY_PAIRED_BRIDGE_TOKEN
```

Use subscription `41d98f2d-c6fb-4ab9-b2f4-43876679543f` for the verified iPhone. Its OneSignal user ID is different and must not be used as a subscription ID. Configure the desktop host's `id` and `origin` as `http://100.121.10.112:28894` to match its phone pairing identity.

Once configured and verified, enable using `systemctl --user enable --now opencode-mobile-bridge`. Inspect only sanitized operational logs with `journalctl --user -u opencode-mobile-bridge`. Stop with `systemctl --user stop opencode-mobile-bridge`. No vLLM or OpenCode service changes are required.
