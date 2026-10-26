#!/bin/bash
# Builds the OpenCode Mobile dev client from the fork and installs it on the
# Wi-Fi-paired iPhone. Progress: ~/mobile-build.log
set -uo pipefail
exec > ~/mobile-build.log 2>&1

step() { echo "=== $1 $(date +%T) ==="; }

export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8

step "node"
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"
command -v node > /dev/null 2>&1 || { echo "node not found; installing node@22 via brew"; brew install node@22 || exit 1; }
node --version || exit 1
npm --version

step "repo update"
cd ~/src/opencode || exit 1
git fetch origin dev || exit 1
git checkout -f -B dev origin/dev || exit 1
git log --oneline -1

step "js deps"
cd mobile/app || exit 1
npm ci --no-fund --no-audit || npm install --no-fund --no-audit || exit 1

step "prebuild ios"
command -v pod > /dev/null 2>&1 || echo "WARN: cocoapods not on PATH; expo may fall back to bundled pod"
npx expo prebuild --platform ios --clean || exit 1

step "find scheme"
SCHEME=$(xcodebuild -list -project ios/*.xcodeproj 2>/dev/null | awk '/Schemes:/{flag=1;next}flag&&NF{print $1;exit}')
[ -z "$SCHEME" ] && SCHEME=$(basename ios/*.xcodeproj .xcodeproj)
echo "scheme: $SCHEME"

step "build (debug, device)"
UDID=00008140-00126C420E40801C
cd ios || exit 1
DEVELOPMENT_TEAM=JTTR6TBH4U xcodebuild \
  -project "${SCHEME}.xcodeproj" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination "id=$UDID" \
  -derivedDataPath ./dd \
  -allowProvisioningUpdates \
  build CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=JTTR6TBH4U || exit 1

APP=$(find dd/Build/Products/Debug-iphoneos -maxdepth 1 -name "*.app" | head -1)
echo "app: $APP"
[ -z "$APP" ] && exit 1

step "install on iPhone"
xcrun devicectl device install app --device "$UDID" "$APP" || exit 1

step "launch"
xcrun devicectl device process launch --device "$UDID" dev.umbecanessa.opencode-mobile || echo "launch failed; open the app manually"

step "DONE"
