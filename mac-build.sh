#!/bin/bash
# Builds the fork's macOS "OpenCode Dev" app (dmg) on the Mac Mini.
# Runs standalone under nohup; progress in ~/opencode-build.log
set -uo pipefail
exec > ~/opencode-build.log 2>&1

step() { echo "=== $1 $(date +%T) ==="; }

cd ~
mkdir -p src
cd src

step "clone/update"
if [ -d opencode/.git ]; then
  git -C opencode fetch origin dev || exit 1
  git -C opencode checkout -B dev origin/dev || exit 1
  git -C opencode reset --hard origin/dev || exit 1
else
  git clone -b dev --single-branch https://github.com/umbecanessa/opencode.git || exit 1
fi

step "bun"
command -v bun > /dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash || exit 1
export PATH="$HOME/.bun/bin:$PATH"
bun --version

cd opencode
step "bun install"
bun install || exit 1

cd packages/desktop
step "prebuild"
bun ./scripts/prebuild.ts || exit 1

step "build"
bun run build || exit 1

step "package dmg"
CSC_IDENTITY_AUTO_DISCOVERY=false \
  bun run package:mac --config.mac.notarize=false --config.mac.target=dmg
status=$?
ls -la dist/*.dmg
if [ $status -ne 0 ]; then
  echo "package failed; retrying with signing fully disabled"
  CSC_IDENTITY_AUTO_DISCOVERY=false \
    bun run package:mac --config.mac.notarize=false --config.mac.target=dmg --config.mac.sign=null || exit 1
  ls -la dist/*.dmg
fi

step "DONE"
