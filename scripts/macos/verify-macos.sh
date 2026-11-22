#!/bin/sh
# Structural sanity checks for the (unsigned) KnockDesk macOS bundle.
#
# Usage:   sh verify-macos.sh [path-to-KnockDesk.app]
# Default: looks for KnockDesk.app next to this script.
# Exit 0 = all checks passed, 1 = at least one FAIL.
#
# Note: one check rewrites venv/pyvenv.cfg to an absolute home path. That is
# exactly what KnockDesk itself does on first launch, so running this script
# before the app does not change any behaviour.

set -u
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
APP_DIR="${1:-$HERE/KnockDesk.app}"

if [ ! -d "$APP_DIR" ]; then
  echo "FAIL  '$APP_DIR' not found (pass the .app path as the first argument)"
  exit 1
fi

CONT="$APP_DIR/Contents"
RES="$CONT/Resources"
MACOS="$CONT/MacOS"
FW="$CONT/Frameworks"
HR="$RES/hermes-runtime"

fails=0
check() { # check <name> <command...>
  name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS  $name"
  else
    echo "FAIL  $name"
    fails=$((fails + 1))
  fi
}

echo "== KnockDesk macOS sanity checks ($APP_DIR) =="

# --- main binary ---
check "main binary exists+exec" test -x "$MACOS/KnockDesk"
check "main binary Mach-O magic" sh -c "head -c 4 \"$MACOS/KnockDesk\" | od -An -tx1 | grep -qi 'cf fa ed fe\|ca fe ba be\|ce fa ed fe'"

# --- framework bundle structure ---
EFW="$FW/Electron Framework.framework"
check "Electron Framework present" test -f "$EFW/Versions/A/Electron Framework"
check "Electron Framework exec" test -x "$EFW/Versions/A/Electron Framework"
check "Versions/Current symlink" test -L "$EFW/Versions/Current"
check "framework top-level symlink" test -L "$EFW/Electron Framework"
check "framework Resources symlink" test -L "$EFW/Resources"

# --- helper app ---
check "helper app present" test -f "$FW/Helper.app/Contents/MacOS/Helper"

# --- payload ---
check "app.asar present" test -s "$RES/app.asar"
check "main.jsc present" test -s "$RES/main.jsc"

# --- Info.plist ---
PLIST="$CONT/Info.plist"
PB=/usr/libexec/PlistBuddy
if [ -x "$PB" ]; then
  check "bundle id app.knockdesk.desktop" sh -c "\"$PB\" -c 'Print :CFBundleIdentifier' \"$PLIST\" | grep -qx 'app.knockdesk.desktop'"
  check "icon KnockDesk.icns" sh -c "\"$PB\" -c 'Print :CFBundleIconFile' \"$PLIST\" | grep -qx 'KnockDesk.icns'"
  check "LSMinimumSystemVersion 11.0" sh -c "\"$PB\" -c 'Print :LSMinimumSystemVersion' \"$PLIST\" | grep -qx '11.0'"
  check "microphone usage description" grep -q 'NSMicrophoneUsageDescription' "$PLIST"
  check "accessibility usage description" grep -q 'NSAccessibilityUsageDescription' "$PLIST"
else
  echo "SKIP  Info.plist checks (no PlistBuddy)"
fi

check "icon file present" test -s "$RES/KnockDesk.icns"

# --- native module archs ---
SQLITE="$RES/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [ -f "$SQLITE" ]; then
  if command -v lipo >/dev/null 2>&1; then
    if lipo "$SQLITE" -verify_arch "$(uname -m)" >/dev/null 2>&1; then
      echo "PASS  better_sqlite3.node matches this Mac ($(uname -m))"
    else
      echo "FAIL  better_sqlite3.node does not contain $(uname -m)"
      fails=$((fails + 1))
    fi
  else
    echo "SKIP  better_sqlite3 arch (no lipo)"
  fi
else
  echo "FAIL  better_sqlite3.node not found at expected path"
  fails=$((fails + 1))
fi

# --- bundled CPython ---
PYBIN="$HR/python/bin/python3.11"
check "bundled python3.11 exists" test -f "$PYBIN"
check "bundled python runs" "$PYBIN" -c 'import sys; assert sys.version_info[:2] == (3, 11)'
if command -v lipo >/dev/null 2>&1 && [ -f "$PYBIN" ]; then
  if lipo "$PYBIN" -verify_arch "$(uname -m)" >/dev/null 2>&1; then
    echo "PASS  bundled python matches this Mac ($(uname -m))"
  else
    echo "FAIL  bundled python does not match $(uname -m)"
    fails=$((fails + 1))
  fi
fi

# --- venv (replicates the app's first-launch relocation) ---
check "pyvenv.cfg present" test -f "$HR/venv/pyvenv.cfg"
check "venv site-packages present" test -d "$HR/venv/lib/python3.11/site-packages"
if [ -f "$HR/venv/pyvenv.cfg" ]; then
  APP_ABS="$(cd "$APP_DIR" && pwd -P)"
  sed -i.bak "s|^home = .*|home = $APP_ABS/Contents/Resources/hermes-runtime/python|" "$HR/venv/pyvenv.cfg" 2>/dev/null
fi
check "venv python runs" "$HR/venv/bin/python" -c 'import sys; print(sys.version)' 
check "hermes CLI --help" "$HR/venv/bin/hermes" --help

echo
if [ "$fails" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$fails CHECK(S) FAILED"
exit 1
