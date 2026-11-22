# Builds the offline NSIS installer for KnockDesk (per-user, no admin).
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/build-nsis-installer.ps1
#
# Stages the exact runtime file set, writes SHA-256 checksums, compiles
# installer/nsis/knockdesk-setup.nsi with makensis, and verifies the output.
# Unsigned builds install with a SmartScreen warning; signing happens only
# via scripts/sign-release.ps1 with a production certificate (never embedded).
param(
  [string]$Version = '3.1.12',
  [string]$VersionDisplay = '',
  [string]$Makensis = 'C:\Program Files (x86)\NSIS\makensis.exe'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
# Derive the display version from $Version when not supplied: the app's own
# build channel appends "-local" (see app-update.yml and the updater log), so
# the Add/Remove Programs entry mirrors it. Hardcoding this made every future
# release show the previous version in ARP.
if (-not $VersionDisplay) { $VersionDisplay = "$Version-local" }
# Short staging path: deep repo paths + nested venv exceed Windows MAX_PATH.
$stage = Join-Path $env:TEMP 'kd-nsis-stage'
$assets = Join-Path $root 'staging\nsis-assets'
$dist = Join-Path $root 'dist'
New-Item $stage, $assets, $dist -ItemType Directory -Force | Out-Null

# Branding icon from the repo logo (regenerated every build, never committed).
# The source has a wide transparent margin that makes shortcuts look tiny, so
# build-icon.py crops to the visible artwork and writes a 256-first frame set.
python (Join-Path $root 'scripts\build-icon.py') (Join-Path $root 'logo.png') (Join-Path $assets 'install.ico')
if ($LASTEXITCODE -ne 0) { throw 'Icon generation failed' }

# Exact runtime set: everything a portable install needs, nothing else.
# Files at repo root are globbed; directories are copied wholesale so the
# layout (resources/, locales/) is preserved exactly as the app expects.
$rootFiles = @('KnockDesk.exe', '*.dll', '*.pak', '*.dat', '*.bin', 'vk_swiftshader*.json', 'wake_word_bg.py', 'resources.pak', 'app-update.yml', 'knockdesk-gen.marker', 'elevate.exe', 'swap-helper.exe', 'main.jsc')
$rootDirs = @('resources', 'locales')
$excludeDirs = @('app.asar.extracted', '__pycache__', 'ensurepip')
$excludeFiles = @('*.log', '*.tmp', '.DS_Store', '*.pyc', '*.pyo', 'app.rebuilt.asar')
Remove-Item (Join-Path $stage '*') -Recurse -Force -ErrorAction SilentlyContinue

foreach ($pat in $rootFiles) {
  foreach ($src in (Get-ChildItem (Join-Path $root $pat) -File -ErrorAction SilentlyContinue)) {
    Copy-Item $src.FullName (Join-Path $stage $src.Name) -Force
  }
}
# Shortcut icon as a small standalone file. Windows extracts shortcut icons
# from the target, and KnockDesk.exe is ~190 MB: the shell times out parsing
# it and shows a blank icon. A 9 KB .ico beside the exe resolves instantly.
$iconIco = Join-Path $assets 'install.ico'
if (Test-Path $iconIco) {
  Copy-Item $iconIco (Join-Path $stage 'KnockDesk.ico') -Force
}
foreach ($dir in $rootDirs) {
  $src = Join-Path $root $dir
  if (-not (Test-Path $src)) { continue }
  $dst = Join-Path $stage $dir
  $xd = @()
  # Pass directory NAMES (not paths) so robocopy excludes them at ANY depth.
  foreach ($ex in $excludeDirs) { $xd += $ex }
  & robocopy $src $dst /E /NJH /NJS /NDL /XD @xd | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed for ${dir}: exit $LASTEXITCODE" }
  $junk = Get-ChildItem $dst -Recurse -Include $excludeFiles -ErrorAction SilentlyContinue
  foreach ($j in @($junk)) { try { if ($j -and $j.FullName) { Remove-Item -LiteralPath $j.FullName -Force -Recurse } } catch {} }
}
foreach ( $req in @('KnockDesk.exe', 'resources\app.asar') ) {
  if (-not (Test-Path (Join-Path $stage $req))) { throw "Missing required runtime file in stage: $req" }
}

# Path-length guard: NSIS cannot open files with paths exceeding ~259 chars.
# Remove staged files whose absolute path is too long (they are cache/test
# artifacts deep inside Python wheels, not runtime code the app loads).
$longPaths = Get-ChildItem $stage -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName.Length -gt 250 }
$removed = 0
foreach ($lf in @($longPaths)) {
  try { if ($lf -and $lf.FullName) { Remove-Item -LiteralPath $lf.FullName -Force; $removed++ } } catch {}
}
if ($removed -gt 0) { Write-Output "Removed $removed files with paths >250 chars (NSIS MAX_PATH guard)" }

# Checksums for the staged payload (shipped next to the installer).
#
# This is a per-file manifest of the installer's contents, tens of thousands
# of lines. It is NOT the release's SHA256SUMS.txt, which lists the release
# artifacts themselves. They used to share a name, and this file silently
# replaced the release list on every installer build.
$files = Get-ChildItem $stage -Recurse -File | Sort-Object FullName
$sha = foreach ($f in $files) {
  $h = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
  "$h  $($f.FullName.Substring($stage.Length + 1))"
}
$sha | Out-File (Join-Path $dist 'SHA256SUMS-files.txt') -Encoding utf8
$sizeMB = [math]::Round(($files | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Output "Staged $($files.Count) files, ${sizeMB} MB"

# Payload gate: the agent runtimes are git-ignored build-host trees. A checkout
# without them (e.g. a plain CI runner that skipped the rebuild step) would
# stage a payload-less installer: the app spawns hermes.exe and the
# computer-use python from these trees, so this must fail loudly instead of
# packaging an installer with a dead agent.
$required = @(
  'resources\hermes-runtime\venv\Scripts\hermes.exe',
  'resources\computer-runtime\venv\Scripts\python.exe',
  'resources\hermes-runtime\src\hermes_cli\web_dist',
  'resources\hermes-runtime\src\node_modules'
)
$missing = @($required | Where-Object { -not (Test-Path (Join-Path $stage $_)) })
if ($missing.Count -gt 0) {
  throw ("Runtime payloads missing from the stage: " + ($missing -join ', ') + ". These trees are git-ignored and exist only on the build host; rebuild them from scripts/requirements-windows-*.txt plus the npm builds (see the CI workflow), or build on the host that holds them.")
}
Write-Output 'Runtime payloads verified in stage.'

if (-not (Test-Path $Makensis)) { throw "makensis not found: $Makensis" }
& $Makensis "/DSTAGE_DIR=$stage" (Join-Path $root 'installer\nsis\knockdesk-setup.nsi')
$out = Join-Path $dist "KnockDesk-Setup-$Version-x64.exe"
if (-not (Test-Path $out)) { throw 'Installer output missing' }
$ih = (Get-FileHash $out -Algorithm SHA256).Hash
"$ih  $(Split-Path $out -Leaf)" | Out-File (Join-Path $dist 'SHA256SUMS-installer.txt') -Encoding utf8
Write-Output "Built $out"
Write-Output "SHA-256: $ih"
