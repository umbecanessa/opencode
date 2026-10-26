# OpenCode Mobile

iPhone companion for OpenCode: one dashboard over the agents running on your machines (Windows desktop, MacBook), built directly on each host's HTTP API over Tailscale. See `docs/mobile/PRD.md` and `docs/mobile/ARCHITECTURE.md` in the repository root for the full product and architecture records, and `docs/mobile/CAPABILITIES.md` for the verified server contract.

## Layout

- `app/` — Expo (SDK 58) / React Native app using Expo Router. Non-route code lives in `app/src/`.
- `bridge/` — (planned) GX10 notification bridge → OneSignal.

The mobile app is intentionally **outside the repository workspace globs** (`packages/*`, `services/*`) so its React Native dependency tree never enters desktop/CLI builds. Install and run it from `mobile/app` with plain npm.

## Running

```sh
cd mobile/app
npm install
npx expo start        # scan the QR with the Expo app / dev build
```

Native modules (secure-store, segmented control) require a development build rather than Expo Go for full function:

```sh
npx eas build --profile development --platform ios   # or npx expo run:ios on the Mac Mini
```

Checks: `npx tsc --noEmit` and `npx expo export --platform ios` (bundle smoke) from `mobile/app`.

## Pairing

Start the phone flow from the Hosts tab: paste a pairing link minted by the desktop app's Pair button (or `opencode-cli pair`). The redemption endpoint is the host's `/auth/connect/{code}` URL over Tailscale, so the phone must be on the tailnet.
