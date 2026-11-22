<#Requires -Version 5.1
<#
.SYNOPSIS
  Signs KnockDesk release artifacts with an OV/EV code-signing certificate.
.DESCRIPTION
  Activates the moment a certificate is available. Accepts either:
    $env:KNOCKDESK_PFX_PATH + $env:KNOCKDESK_PFX_PASSWORD
    $env:WINDOWS_CERT_PFX_B64 + $env:WINDOWS_CERT_PASSWORD (CI secrets)
  $env:KNOCKDESK_TIMESTAMP_URL is optional (defaults to DigiCert RFC3161).
  Signs KnockDesk.exe and the installer, timestamps, then verifies.
  Without a certificate this script refuses to run rather than self-signing:
  a self-signed signature trains users to click through warnings and is
  worse than shipping unsigned with hashes published.
#>
[CmdletBinding()]
param(
  [string]$ExePath = (Join-Path $PSScriptRoot '..\KnockDesk.exe'),
  [string]$InstallerPath = '',
  [string]$TimestampUrl = $env:KNOCKDESK_TIMESTAMP_URL
)
$ErrorActionPreference = 'Stop'

$pfxPath = $env:KNOCKDESK_PFX_PATH
$pfxPassword = $env:KNOCKDESK_PFX_PASSWORD
$tempPfx = $null

try {
  # CI exposes the certificate as a base64 secret. Decode it to a temporary
  # file so the same signtool path works locally and in the workflow.
  if (-not $pfxPath -and $env:WINDOWS_CERT_PFX_B64) {
    $tempPfx = Join-Path ([System.IO.Path]::GetTempPath()) ("knockdesk-signing-{0}.pfx" -f [guid]::NewGuid().ToString('N'))
    [System.IO.File]::WriteAllBytes($tempPfx, [Convert]::FromBase64String($env:WINDOWS_CERT_PFX_B64))
    $pfxPath = $tempPfx
  }
  if (-not $pfxPassword) { $pfxPassword = $env:WINDOWS_CERT_PASSWORD }

  if (-not $pfxPath -or -not (Test-Path $pfxPath)) {
    throw 'No code-signing certificate found. Refusing to self-sign: obtain an OV/EV certificate first (see docs/ops/signing.md).'
  }
  if (-not $pfxPassword) {
    throw 'No certificate password set. Pass it via environment/CI secret, never on the command line.'
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
  if (-not $InstallerPath) {
    # Builder writes versioned names such as KnockDesk-Setup-3.1.12-x64.exe.
    $installerCandidates = Get-ChildItem (Join-Path $PSScriptRoot '..\dist\KnockDesk-Setup-*.exe') -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending
    if ($installerCandidates) { $InstallerPath = $installerCandidates[0].FullName }
  }
  if ($InstallerPath -and (Test-Path $InstallerPath)) { $targets += $InstallerPath }

  foreach ($t in $targets) {
    Write-Host "Signing $t ..."
    & $signtool sign /fd SHA256 /f $pfxPath /p $pfxPassword /tr $TimestampUrl /td SHA256 $t
    if ($LASTEXITCODE -ne 0) { throw "signtool failed for $t" }
    & $signtool verify /pa $t | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "verify failed for $t" }
    Write-Host "OK: $t"
  }
  Write-Host 'All artifacts signed + timestamped + verified.'
}
finally {
  if ($tempPfx -and (Test-Path $tempPfx)) {
    Remove-Item $tempPfx -Force -ErrorAction SilentlyContinue
  }
}
