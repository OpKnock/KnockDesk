# macOS Release Status

Date: 2026-10-17. Status: **BLOCKED — no macOS hardware or signing identity available.**

## What exists
- Maintained source shell (`resources/hermes-runtime/src/electron/`) compiles on
  macOS in CI (renderer smoke test passes on macOS runner).
- `resources/hermes-runtime/src/electron/services/macos-updater.js` and
  `macos-permissions.js` exist (notarization logic, permission prompts).
- `resources/hermes-runtime/venv/` contains Windows binaries only
  (`Scripts/hermes.exe`) — no macOS Python venv, no Darwin `.node` files.

## What's missing for a macOS distributable
1. **No macOS build machine** — the repo has never been packaged on Darwin.
2. **No Apple Developer ID** — signing + notarization require a paid Apple
   Developer account ($99/year) and certificates.
3. **No macOS Hermes venv** — the Hermes Python runtime needs to be built
   for Darwin (different site-packages, no .exe, different native modules).
4. **No macOS native binaries** — `@jitsi/robotjs`, `better-sqlite3`,
   `@picovoice/*` all need Darwin builds (.node files for arm64/x64).
5. **No macOS installer pipeline** — no `electron-builder` config for `.dmg`,
   no `Info.plist` with proper `LSUIElement`/entitlements.

## Path forward (when macOS hardware + Apple Developer account are available)
1. Bootstrap Hermes on macOS (the repo's install scripts target Windows only)
2. Add `electron-builder` macOS config: `.dmg` target, hardened runtime,
   entitlements for mic/screen/screen-recording
3. Sign with Developer ID Application certificate
4. Notarize via `notarytool` (App Store Connect API key)
5. Staple the notarization ticket
6. Test Gatekeeper first-launch on a clean macOS VM

This is a **minimum 2-week effort** assuming hardware and accounts exist today.
