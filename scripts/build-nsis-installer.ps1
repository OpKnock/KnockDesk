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
  [string]$VersionDisplay = '3.1.12-local',
  [string]$Makensis = 'C:\Program Files (x86)\NSIS\makensis.exe'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
# Short staging path: deep repo paths + nested venv exceed Windows MAX_PATH.
$stage = Join-Path $env:TEMP 'kd-nsis-stage'
$assets = Join-Path $root 'staging\nsis-assets'
$dist = Join-Path $root 'dist'
New-Item $stage, $assets, $dist -ItemType Directory -Force | Out-Null

# Branding icon from the repo logo (regenerated every build, never committed).
python -c "from PIL import Image; im=Image.open('logo.png'); im.save('staging/nsis-assets/install.ico', sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])"

# Exact runtime set: everything a portable install needs, nothing else.
# Files at repo root are globbed; directories are copied wholesale so the
# layout (resources/, locales/) is preserved exactly as the app expects.
$rootFiles = @('KnockDesk.exe', '*.dll', '*.pak', '*.dat', '*.bin', 'vk_swiftshader*.json', 'wake_word_bg.py', 'resources.pak', 'app-update.yml', 'knockdesk-gen.marker', 'elevate.exe', 'swap-helper.exe', 'main.jsc')
$rootDirs = @('resources', 'locales')
$excludeDirs = @('app.asar.extracted', '__pycache__', 'ensurepip')
$excludeFiles = @('*.log', '*.tmp', '.DS_Store', '*.pyc', '*.pyo')
Remove-Item (Join-Path $stage '*') -Recurse -Force -ErrorAction SilentlyContinue

foreach ($pat in $rootFiles) {
  foreach ($src in (Get-ChildItem (Join-Path $root $pat) -File -ErrorAction SilentlyContinue)) {
    Copy-Item $src.FullName (Join-Path $stage $src.Name) -Force
  }
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
$files = Get-ChildItem $stage -Recurse -File | Sort-Object FullName
$sha = foreach ($f in $files) {
  $h = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
  "$h  $($f.FullName.Substring($stage.Length + 1))"
}
$sha | Out-File (Join-Path $dist 'SHA256SUMS.txt') -Encoding utf8
$sizeMB = [math]::Round(($files | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Output "Staged $($files.Count) files, ${sizeMB} MB"

if (-not (Test-Path $Makensis)) { throw "makensis not found: $Makensis" }
& $Makensis "/DSTAGE_DIR=$stage" (Join-Path $root 'installer\nsis\knockdesk-setup.nsi')
$out = Join-Path $dist "KnockDesk-Setup-$Version-x64.exe"
if (-not (Test-Path $out)) { throw 'Installer output missing' }
$ih = (Get-FileHash $out -Algorithm SHA256).Hash
"$ih  $(Split-Path $out -Leaf)" | Out-File (Join-Path $dist 'SHA256SUMS-installer.txt') -Encoding utf8
Write-Output "Built $out"
Write-Output "SHA-256: $ih"
