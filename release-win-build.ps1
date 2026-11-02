$ErrorActionPreference = "Continue"
$log = "C:\Users\umber\opencode-src-memory\win-release.log"
$env:OPENCODE_VERSION = "26.12.2"
Set-Location C:\Users\umber\opencode-src-memory\packages\cli
"=== cli build $(Get-Date -Format T)" | Add-Content $log
bun run build 2>&1 | Add-Content $log
if ($LASTEXITCODE) { "cli build FAILED $LASTEXITCODE" | Add-Content $log; exit 1 }
Set-Location C:\Users\umber\opencode-src-memory\packages\desktop
"=== desktop build $(Get-Date -Format T)" | Add-Content $log
bun run build 2>&1 | Add-Content $log
if ($LASTEXITCODE) { "desktop build FAILED $LASTEXITCODE" | Add-Content $log; exit 1 }
"=== package win $(Get-Date -Format T)" | Add-Content $log
bunx electron-builder --win --x64 --publish never --config electron-builder.config.ts 2>&1 | Add-Content $log
if ($LASTEXITCODE) { "package FAILED $LASTEXITCODE" | Add-Content $log; exit 1 }
"=== DONE $(Get-Date -Format T)" | Add-Content $log
