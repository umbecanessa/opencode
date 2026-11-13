$ErrorActionPreference = "Continue"
# Builds the checkout this script lives in; on a release run that tree must be at
# the intended release commit (the mac side does an explicit reset to fork/dev).
$log = Join-Path $PSScriptRoot "win-release.log"
$env:OPENCODE_VERSION = "26.12.24"
"=== head $(git -C $PSScriptRoot log --oneline -1)" | Add-Content $log
Set-Location (Join-Path $PSScriptRoot "packages\cli")
"=== cli build $(Get-Date -Format T)" | Add-Content $log
bun run build 2>&1 | Add-Content $log
if ($LASTEXITCODE) { "cli build FAILED $LASTEXITCODE" | Add-Content $log; exit 1 }
Set-Location (Join-Path $PSScriptRoot "packages\desktop")
"=== desktop build $(Get-Date -Format T)" | Add-Content $log
bun run build 2>&1 | Add-Content $log
if ($LASTEXITCODE) { "desktop build FAILED $LASTEXITCODE" | Add-Content $log; exit 1 }
"=== package win $(Get-Date -Format T)" | Add-Content $log
bunx electron-builder --win --x64 --publish never --config electron-builder.config.ts 2>&1 | Add-Content $log
if ($LASTEXITCODE) { "package FAILED $LASTEXITCODE" | Add-Content $log; exit 1 }
"=== DONE $(Get-Date -Format T)" | Add-Content $log
