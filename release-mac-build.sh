#!/bin/bash
set -uo pipefail
exec > ~/opencode-release.log 2>&1
step() { echo "=== $1 $(date +%T) ==="; }
cd ~/src/opencode || exit 1
step "update"
git fetch origin dev && git checkout -B dev origin/dev && git reset --hard origin/dev || exit 1
export PATH="$HOME/.bun/bin:$PATH"
step "bun install"
bun install || exit 1
export OPENCODE_VERSION=26.12.2
# The login-keychain password stays off this script: read it from a 600-mode file
# on the Mini (~/.opencode-release-keychain) or the KEYCHAIN_PASSWORD env var.
KEYCHAIN_PASS="${KEYCHAIN_PASSWORD:-$(cat ~/.opencode-release-keychain 2>/dev/null)}"
security unlock-keychain -p "$KEYCHAIN_PASS" ~/Library/Keychains/login.keychain-db
security set-keychain-settings ~/Library/Keychains/login.keychain-db
( while pgrep -f release-mac-build.sh >/dev/null; do security unlock-keychain -p "$KEYCHAIN_PASS" ~/Library/Keychains/login.keychain-db 2>/dev/null; sleep 15; done ) &
caffeinate -disu &
CAFF=$!
step "cli build"
(cd packages/cli && bun run build) || { echo "cli FAILED"; kill $CAFF 2>/dev/null; exit 1; }
step "desktop build"
(cd packages/desktop && bun run build) || { echo "desktop FAILED"; kill $CAFF 2>/dev/null; exit 1; }
step "package mac"
(cd packages/desktop && bunx electron-builder --mac --arm64 --publish never --config electron-builder.config.ts) || { echo "package FAILED"; kill $CAFF 2>/dev/null; exit 1; }
kill $CAFF 2>/dev/null
step "DONE"
