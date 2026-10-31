<#Requires -Version 5.1
<#
.SYNOPSIS
  Signs KnockDesk release artifacts with an OV/EV code-signing certificate.
.DESCRIPTION
  Activates the moment a certificate is available. Expects:
    $env:KNOCKDESK_PFX_PATH  - path to the .pfx (never commit it)
    $env:KNOCKDESK_PFX_PASSWORD - PFX password (CI secret, never logged)
    $env:KNOCKDESK_TIMESTAMP_URL (optional, defaults to DigiCert RFC3161)
  Signs KnockDesk.exe (and installer when present), timestamps, then verifies.
  Without a certificate this script refuses to run rather than self-signing:
  a self-signed signature trains users to click through warnings and is
  worse than shipping unsigned with hashes published.
#>
[CmdletBinding()]
param(
  [string]$ExePath = (Join-Path $PSScriptRoot '..\KnockDesk.exe'),
  [string]$TimestampUrl = $env:KNOCKDESK_TIMESTAMP_URL
)
$ErrorActionPreference = 'Stop'

if (-not $env:KNOCKDESK_PFX_PATH -or -not (Test-Path $env:KNOCKDESK_PFX_PATH)) {
  throw 'KNOCKDESK_PFX_PATH is not set or points nowhere. Refusing to self-sign: obtain an OV/EV code-signing certificate first (see docs/ops/signing.md).'
}
if (-not $env:KNOCKDESK_PFX_PASSWORD) {
  throw 'KNOCKDESK_PFX_PASSWORD is not set. Pass it via environment/CI secret, never on the command line.'
}
if (-not $TimestampUrl) { $TimestampUrl = 'http://timestamp.digicert.com' }

$signtool = 'signtool.exe'
try { & $signtool 2>&1 | Out-Null } catch {
  $kits = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
  if (-not $kits) { throw 'signtool.exe not found. Install the Windows SDK.' }
  $signtool = Join-Path $kits.FullName 'x64\signtool.exe'
}

$targets = @($ExePath)
$installer = Join-Path $PSScriptRoot '..\dist\KnockDesk-Setup.exe'
if (Test-Path $installer) { $targets += $installer }

foreach ($t in $targets) {
  Write-Host "Signing $t ..."
  & $signtool sign /fd SHA256 /f $env:KNOCKDESK_PFX_PATH /p $env:KNOCKDESK_PFX_PASSWORD /tr $TimestampUrl /td SHA256 $t
  if ($LASTEXITCODE -ne 0) { throw "signtool failed for $t" }
  & $signtool verify /pa $t | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "verify failed for $t" }
  Write-Host "OK: $t"
}
Write-Host 'All artifacts signed + timestamped + verified.'
