# KnockDesk macOS cross-build (built on Windows)

Produces two distribution zips — `KnockDesk-3.1.12-macOS-arm64.zip` (Apple
Silicon) and `KnockDesk-3.1.12-macOS-x64.zip` (Intel) — **without any Mac
hardware**. The result is an unsigned `.app` bundle; a friend tests on real
macOS before signing/notarization.

## How it works (strategy)

Bytecode, not machine code, is the portability trick — with two deliberate
exceptions:

| Piece | Reused cross-platform? | Why |
|---|---|---|
| `app.asar` | **Yes** — re-packed from the Windows release payload | JS/bytecode inside is V8-uniform; Electron 44.7.2 darwin = same V8 as the Windows build |
| `electron/main.jsc` (bytenode) | **Yes** | bytenode output is V8-version-locked, not OS-locked |
| Electron runtime | **No** — official `electron-v44.7.2-darwin-{arm64,x64}.zip` | Mach-O binaries per arch |
| Bundled node (`Resources/bin/node`) | **No** — nodejs.org darwin tarball | Required by whatsapp pairing (`resolveNode`) + PATH injection in main.jsc |
| CPython | **No** — python-build-standalone `cpython-3.11.x` per-arch `install_only` tarball | Mach-O per arch |
| Python packages | **Yes, but not the .so/.dylib parts** — wheels downloaded with `pip download --platform macosx_*` on Windows, unpacked with `zipfile` | Resolved first by `uv pip compile --python-platform` so that `platform_system` markers (e.g. portalocker → pywin32) are evaluated for the *target* OS, then fetched with `pip download --no-deps`; per-arch pin overrides where Intel wheels no longer exist (onnxruntime 1.22.1 universal2) |
| `better-sqlite3` | **No** — official electron-v132 darwin prebuilds | N-API node module, Mach-O |
| robotjs, porcupine, pvrecorder | **Yes** — darwin `.node` builds already ship inside the payload | prebuilt mac binaries in the asar |

### The symlink problem (and why this build is not fragile)

macOS bundles need real Unix symlinks (framework internals, `venv/bin/python`,
`python/bin/python*`). A Windows shell without elevation or Developer Mode
**cannot create symlinks**, and .NET's Expand-Archive silently mangles symlink
zip entries into text-file stubs. Everything here therefore avoids symlinks on
disk entirely:

- `scripts/unpack.mjs` parses PK-ZIP and tar.gz directly in Node: regular
  files are written to disk, symlink entries are returned in a `Map` and never
  touch the filesystem.
- `scripts/zip-with-mode.mjs` writes the final zip and re-bakes every symlink
  as a zip entry whose payload is the target string (that is literally how a
  ZIP stores a symlink — no OS support needed) with mode `120777`. Unix modes
  (`0755` for anything with Mach-O magic or a `#!` shebang, `0644` otherwise)
  are embedded per entry; Archive Utility/ditto restore them.
- The only "symlinks" that exist solely in the zip map are the venv launchers,
  which are never created on disk; everything extracted from real archives
  round-trips through reader tests against Python's `zipfile`.

Windows *dos* drop these mode bits entirely, which is exactly why a normal
Windows-made zip of a mac app fails with "permission denied" on launch.

## What is dropped from the mac bundle (on purpose)

- `browsers/` — Windows Playwright browser builds (~750MB). Hermes
  `dep_ensure` installs what it needs on the user's Mac.
- `python-embedded/` — Windows embeddable Python; replaced by PBS CPython.
- `swap-helper.exe`, `elevate.exe` — Windows-only helpers.
- `hermes-runtime/src/node_modules`, `__pycache__` — Windows dev deps.
- darwin `@napi-rs/canvas` — **skipped on the finding that no `require` site
  exists** for it in the shipped code (known risk, revisit if canvas errors
  appear).
- Windows/Linux/Raspberry prebuild directories inside `app.asar.unpacked`
  (robotjs bin/build, canvas win32 packages, picovoice non-mac lib dirs).

## Layout

```
downloads/   cached official artifacts (electron zip, node tarball, PBS tarball, sqlite prebuild)
staging/     per-arch assembled KnockDesk.app trees (big; safe to delete)
dist/        final zips + SHA-256SUMS.txt
scripts/
  build-macos.mjs      orchestrator: downloads, assembly, venv, Info.plist, zips
  unpack.mjs           privilege-free zip + tar.gz readers (symlink maps)
  zip-with-mode.mjs    PK-ZIP writer with Unix modes + symlinks (store for .asar)
  icns.mjs             KnockDesk.icns generator (GDI+ scale -> pure-JS icns pack)
requirements-darwin.txt  exact pins from the shipped Windows venv, minus
                         Windows-only packages (pywin32, pywinpty, tzdata),
                         plus ptyprocess and pip tooling
test/                    writer/reader round-trips validated with Python zipfile
```

## Build

```sh
node scripts/build-macos.mjs --arch arm64   # one arch
node scripts/build-macos.mjs               # both
```

Requires network (official GitHub/nodejs.org artifacts) and Node.js on
Windows. No elevation, no Developer Mode, no Mac.

## Friend testing

See `MACOS_TEST_PLAN.md` (and `verify-macos.sh` for automated structural
checks). Unsigned-app notes: right-click → Open, or `xattr -cr KnockDesk.app`.

## Signing (later, real release)

With the Apple Developer account, sign with `rcodesign` (pure Rust, no Mac
needed) or `codesign` on any Mac: export a `.p12` from the Developer portal,
sign `KnockDesk.app` inside the bundle and helpers, staple the notarization
ticket, and re-zip. The website download card switches from "Coming soon"
to the signed zips once they exist.
