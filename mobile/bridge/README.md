# Mobile notification bridge

Runs independently of OpenCode and vLLM. No inbound listener. **Not deployed or push-validated yet.**

## Private setup

Create `config.json` (ignored by git) with:

```json
{"hosts":[{"id":"PHONE_HOST_ID","origin":"http://TAILSCALE_IP:28894","tokenEnv":"DESKTOP_TOKEN","subscriptions":["ONESIGNAL_SUBSCRIPTION_ID"],"events":["completed","failed","approval","question"]}]}
```

Host IDs must match the phone's paired registry. Enroll only your phone's exact OneSignal subscription ID; there is no public enrollment endpoint or all-subscribers broadcast. Each host's `events` list controls preferences. Use separate bridge pairing credentials, not the phone credential. These credentials grant broad server access, not enforced read-only access.

Set `ONESIGNAL_APP_ID`, `ONESIGNAL_API_KEY`, and each host's credential variable in a private `.env` file; protect directory and files with owner-only permissions. Never commit or paste credentials into chat. Run `bun install`, then `bun start`. Persist `bridge.sqlite` and its WAL beside the config. Run one supervised process only. Do not expose this directory through a web server.

## Delivery guarantees and limits

SQLite seen/outbox records survive restarts. Retries reuse OneSignal idempotency keys. Provider acceptance is not confirmation that the phone displayed the alert. First observation baselines old completions but alerts on outstanding questions/permissions. Offline hosts do not become failed agents. Polling observes the latest 100 sessions and active-session requests; short-lived requests and older changes can be missed. Interrupted/cancelled runs are not failure notifications. Host credentials and content are excluded from logs/payloads.

Before deployment: verify outcome shapes against each host, enroll the phone, configure APNs and iOS OneSignal SDK, test locked-phone delivery and routing, restart dedupe, token expiry, and host sleep/recovery. Disable a host by removing it from config and restarting; revoke its bridge credential on the host. Retain the database to avoid replaying notifications.
