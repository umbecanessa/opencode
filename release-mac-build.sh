#!/bin/bash
set -uo pipefail
exec > ~/opencode-release.log 2>&1
step() { echo "=== $1 $(date +%T) ==="; }
cd ~/src/opencode || exit 1
step "update"
git fetch origin dev && git checkout -B dev origin/dev && git reset --hard origin/dev || exit 1
export PATH="$HOME/.bun/bin:$PATH"
step "keychains"
# Signing/notarization lives in build.keychain-db: the Developer ID Application
# key, the Developer ID G2 intermediate, and the "notarytool-storage" profile.
# notarytool resolves keychain profiles from the DEFAULT keychain only, so the
# default must point at the build keychain; otherwise electron-builder silently
# falls back to any Apple Development identity in the login keychain and skips
# notarization, and Squirrel.Mac then rejects the update against the installed
# app's Developer ID designated requirement.
KC=$HOME/Library/Keychains/build.keychain-db
security unlock-keychain -p "$(cat ~/signing/.keychain-pass)" "$KC" || exit 1
security default-keychain -d user -s "$KC" || exit 1
security default-keychain -d user | grep build.keychain || exit 1
security list-keychains -d user -s "$KC" "$HOME/Library/Keychains/login.keychain-db" || exit 1
# The login keychain stays unlocked too; some tool paths touch it during the build.
KEYCHAIN_PASS="${KEYCHAIN_PASSWORD:-$(cat ~/.opencode-release-keychain 2>/dev/null)}"
security unlock-keychain -p "$KEYCHAIN_PASS" ~/Library/Keychains/login.keychain-db
security set-keychain-settings ~/Library/Keychains/login.keychain-db
( while pgrep -f release-mac-build.sh >/dev/null; do
    security unlock-keychain -p "$(cat ~/signing/.keychain-pass)" "$KC" 2>/dev/null
    security unlock-keychain -p "$KEYCHAIN_PASS" ~/Library/Keychains/login.keychain-db 2>/dev/null
    sleep 15
  done ) &
caffeinate -disu &
CAFF=$!
step "identity check"
# Fail before building, not after shipping, when the Developer ID identity or
# the notarization profile went missing from the build keychain.
security find-identity -v -p codesigning "$KC" | grep "Developer ID Application" || { echo "NO Developer ID identity in $KC"; kill $CAFF 2>/dev/null; exit 1; }
export APPLE_KEYCHAIN="$KC" APPLE_KEYCHAIN_PROFILE=notarytool-storage
xcrun notarytool history --keychain-profile notarytool-storage --keychain "$KC" </dev/null >/dev/null 2>&1 || { echo "NO notarytool-storage profile in $KC"; kill $CAFF 2>/dev/null; exit 1; }
step "bun install"
bun install || exit 1
export OPENCODE_VERSION=26.12.27
step "cli build"
(cd packages/cli && bun run build) || { echo "cli FAILED"; kill $CAFF 2>/dev/null; exit 1; }
step "desktop build"
(cd packages/desktop && bun run build) || { echo "desktop FAILED"; kill $CAFF 2>/dev/null; exit 1; }
step "package mac"
# Pin the identity: auto-discovery picking the wrong certificate is exactly
# what broke the 26.12.0-2 auto-updates.
(cd packages/desktop && bunx electron-builder --mac --arm64 --publish never --config electron-builder.config.ts --config.mac.identity="Developer ID Application") || { echo "package FAILED"; kill $CAFF 2>/dev/null; exit 1; }
step "verify"
APP="packages/desktop/dist/mac-arm64/OpenCode Dev.app"
codesign -dvv "$APP" 2>&1 | grep "Developer ID Application" || { echo "artifact NOT Developer ID signed"; kill $CAFF 2>/dev/null; exit 1; }
spctl -a -vv -t install "$APP" || { echo "artifact rejected by Gatekeeper"; kill $CAFF 2>/dev/null; exit 1; }
kill $CAFF 2>/dev/null
step "DONE"
