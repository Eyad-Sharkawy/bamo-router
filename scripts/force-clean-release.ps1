# Force-unlock and remove release/ on Windows.
# Run from project root:  .\scripts\force-clean-release.ps1

$ErrorActionPreference = 'Continue'
$release = Join-Path $PSScriptRoot '..\release' | Resolve-Path -ErrorAction SilentlyContinue

if (-not $release) {
    Write-Host 'release/ does not exist — nothing to clean.'
    exit 0
}

Write-Host 'Stopping Bamo Router / Electron...'
taskkill /IM 'Bamo Router.exe' /F 2>$null
taskkill /IM 'electron.exe' /F 2>$null
Start-Sleep -Seconds 1

Write-Host 'Restarting File Explorer (releases folder locks)...'
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Start-Process explorer

Start-Sleep -Seconds 2

Write-Host "Removing $release ..."
try {
    Remove-Item -LiteralPath $release -Recurse -Force -ErrorAction Stop
    Write-Host 'Done — release/ deleted.'
    exit 0
}
catch {
    Write-Host ''
    Write-Host 'Still locked. Try:' -ForegroundColor Yellow
    Write-Host '  1. Close Cursor/VS Code tabs previewing files under release/'
    Write-Host '  2. Close all Explorer windows'
    Write-Host '  3. Reboot, then run this script again'
    Write-Host ''
    Write-Host 'Or build without deleting:  npm run dist:win:alt' -ForegroundColor Cyan
    exit 1
}
