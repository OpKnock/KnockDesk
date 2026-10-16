# Registers KnockDesk with Windows on this machine.
#
# Creates/updates the Start Menu shortcut (so Windows Search finds
# KnockDesk) and an App Paths entry (so Win+R + "KnockDesk" launches it).
# Idempotent: safe to re-run. Per-user only (HKCU + %APPDATA%), no admin.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/register-windows.ps1
param(
  [string]$ExePath = (Join-Path (Split-Path $PSScriptRoot -Parent) 'KnockDesk.exe'),
  [string]$AppName = 'KnockDesk'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $ExePath)) { throw "Executable not found: $ExePath" }
$ExePath = (Resolve-Path $ExePath).Path
$workDir = Split-Path $ExePath -Parent

$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$lnk = Join-Path $programs "$AppName.lnk"
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = $ExePath
$sc.WorkingDirectory = $workDir
$sc.IconLocation = "$ExePath,0"
$sc.Description = 'KnockDesk - Your advanced desktop assistant.'
$sc.Save()
Write-Output "Start Menu shortcut: $lnk"

$appPaths = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths'
$key = Join-Path $appPaths 'KnockDesk.exe'
if (-not (Test-Path $key)) { New-Item $key -Force | Out-Null }
Set-ItemProperty $key -Name '(default)' -Value $ExePath
Set-ItemProperty $key -Name 'Path' -Value $workDir
Write-Output "App Paths entry: $key"

# Verify
$check = $ws.CreateShortcut($lnk)
if ($check.TargetPath -ne $ExePath) { throw 'Shortcut target mismatch after save' }
if (-not (Test-Path $check.TargetPath)) { throw 'Shortcut target missing on disk' }
Write-Output 'Verified: Start Menu search should list KnockDesk within a minute.'
