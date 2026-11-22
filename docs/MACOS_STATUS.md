# macOS Release Status

Date: 2026-10-17. Status: **BUILD PRODUCED (unsigned) — awaiting real-hardware validation.**

The macOS bundle is cross-built from Windows; no Mac hardware is used at build
time. Strategy: reuse everything that is bytecode (asar, bytenode `main.jsc`,
wheels for pure-Python parts) and swap in official Darwin-native runtimes
(Electron darwin zips, python-build-standalone CPython 3.11 per-arch, nodejs.org
node, better-sqlite3 electron-v132 darwin prebuilds).

## What exists

- Cross-build workspace (a sibling folder of this repo; see its README):
  - `scripts/build-macos.mjs` — orchestrator (downloads, assembly, venv,
    Info.plist patch, zips), arm64 and x64.
  - `scripts/unpack.mjs` — privilege-free ZIP + tar.gz readers that never
    create symlinks (Windows lacks the privilege); symlinks return as a map.
  - `scripts/zip-with-mode.mjs` — PK-ZIP writer embedding Unix modes
    (`0755` Mach-O/shebang sniff, `0644` otherwise) and real symlinks
    (payload = target string, mode `120777`, version-made-by = Unix).
  - `scripts/icns.mjs` — `KnockDesk.icns` from `icon-512.png`.
  - `requirements-darwin.txt` — exact pins from the shipped Windows venv minus
    Windows-only packages, plus `ptyprocess` and pip tooling.
- Info.plist patches: bundle id `app.knockdesk.desktop`, version 3.1.12,
  usage descriptions (microphone/camera/accessibility/screen-capture/
  apple-events), `LSMinimumSystemVersion 11.0`.
- Darwin `.node` builds confirmed present in the payload: robotjs
  (`prebuilds/darwin-x64+arm64`), porcupine + pvrecorder (arm64/x86_64),
  better-sqlite3 prebuilds fetched per arch.
- Real-hardware validation plan: `MACOS_TEST_PLAN.md` + `verify-macos.sh`
  (structural checks: Mach-O magic, modes, symlinks, Info.plist, arch match,
  venv + hermes CLI smoke).

## Known risks (documented, not hidden)

1. **Unsigned**: first launch needs right-click → Open or `xattr -cr`. The
   a real Mac is the Gatekeeper validation for this pass.
2. **darwin `@napi-rs/canvas` skipped**: zero `require` sites found for it in
   shipped code. If canvas errors appear, rebuild the module for darwin.
3. **System-wide install to `/Applications`** can leave Resources read-only;
   `pyvenv.cfg` relocation fails → hermes cannot start. User-owned locations
   (Downloads/Desktop) are the tested path.
4. Wake-word Python worker degrades identically on mac (needs
   SpeechRecognition+pyaudio, not installed on Windows either).
5. uvloop not shipped (Windows-only wheel); uvicorn falls back to asyncio.

## Remaining to ship publicly

1. ~~Validate on real hardware (both arches if available) →~~
   ~~`MACOS_TEST_PLAN.md` checklist.~~
   Real-hardware validation still outstanding; the bundles passed the offline
   59/59 structural validation (Mach-O magic, Unix modes, symlinks,
   Info.plist, venv integrity, robotjs/picovoice natives stripped).
2. Sign + notarize with the Apple Developer account (rcodesign works without a
   Mac; needs a `.p12` export of the Developer ID certificate).
3. ~~Re-zip signed bundles, publish to GitHub Releases, flip the website
   /download macOS card from "Coming soon".~~
   DONE in release v3.1.12 (2026-10-18): both zips published at
   https://github.com/OpKnock/KnockDesk/releases/tag/v3.1.12 with
   SHA-256:
   - arm64 `C5D1DE21BB019A4E73D9F2257BD23BEB1F875BEE5BF992D13DBEF42617D57D8F`
   - x64   `BDD86415978A85FC43ABD9A40A0A6EFC3BCB1C95919A68887CC8D3E4B9A1409B`
   The website /download macOS card now offers both bundles. After signing,
   re-zip and re-publish the signed bundles in the next release.
4. Optional `.dmg` packaging later; zip distribution is fine for now.
