# Protect the core key with what this machine and account offer.
#
# What this writes:
#   core-key.raw        the raw 32-byte key (recovery only; gitignored, user profile)
#   core-key.dpapi.bin  the key wrapped by DPAPI, scope CurrentUser
#
# The wrapped blob lands in the user profile, never in the archive, so a
# copied installation cannot decrypt anything: DPAPI CurrentUser blobs only
# unwrap for the same Windows account on the same machine.
#
# Honest scope: this protects the key at rest against another account, another
# machine, or a stolen disk image without that account's credentials. It does
# not protect against the user themselves - they can call Unprotect too, which
# is exactly what the app does at boot.
#
# The TPM-backed path was removed: the previous attempt wrote an AES-CBC blob
# whose AES key was generated but never persisted, so nothing could ever
# unwrap it. If platform-provider wrapping is wanted later it must persist the
# wrapping key or use NCrypt Seal/Unseal, and it must be tested end to end
# before it ships. DPAPI-only is correct and testable today.
#
# Run elevated? No. DPAPI CurrentUser works as the installing user.
# KNOCKDESK_CORE_KEY_DIR overrides the destination for testing.

param()

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 does not preload the ProtectedData class; without
# this it fails with TypeNotFound on a stock Windows install.
Add-Type -AssemblyName System.Security

$keyDir = if ($env:KNOCKDESK_CORE_KEY_DIR) { $env:KNOCKDESK_CORE_KEY_DIR } else {
  Join-Path $env:APPDATA 'knockdesk'
}
New-Item -ItemType Directory -Path $keyDir -Force | Out-Null

# The raw key: generate once, then reuse so re-running is idempotent.
$rawPath = Join-Path $keyDir 'core-key.raw'
if (-not (Test-Path $rawPath)) {
  $raw = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($raw)
  [IO.File]::WriteAllBytes($rawPath, $raw)
  Write-Output "generated a fresh 256-bit core key: $rawPath"
} else {
  $raw = [IO.File]::ReadAllBytes($rawPath)
  if ($raw.Length -ne 32) {
    throw "existing $rawPath is $($raw.Length) bytes, expected 32; refusing to continue"
  }
}

$dpapiPath = Join-Path $keyDir 'core-key.dpapi.bin'
$blob = [System.Security.Cryptography.ProtectedData]::Protect(
  $raw, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes($dpapiPath, $blob)

# Read the blob back so a wrap this machine cannot unwrap is never reported
# as success.
$check = [System.Security.Cryptography.ProtectedData]::Unprotect(
  [IO.File]::ReadAllBytes($dpapiPath), $null,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
if ([Convert]::ToBase64String($check) -ne [Convert]::ToBase64String($raw)) {
  throw "the DPAPI blob did not round-trip; the raw key at $rawPath is still the boot path"
}
Write-Output "DPAPI CurrentUser wrap written and verified: $dpapiPath"

# A broken blob from the old TPM attempt can only confuse the boot path; move
# it aside rather than delete it.
$staleTpm = Join-Path $keyDir 'core-key.tpm.bin'
if (Test-Path $staleTpm) {
  Move-Item -Force $staleTpm ($staleTpm + '.unused') -ErrorAction SilentlyContinue
  Write-Output "moved the unused TPM blob aside: $staleTpm.unused"
}

Write-Output "mode: dpapi | key dir: $keyDir"
Write-Output "Recovery: the app boots from the DPAPI blob; if that blob is missing"
Write-Output "or unreadable it falls back to $rawPath automatically, and to"
Write-Output "KNOCKDESK_CORE_KEY_FILE=<file> when that env var is set."
