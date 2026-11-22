# KnockDesk macOS — Test Plan (unsigned distribution)

This build is **unsigned** (no Apple Developer signature/notarization yet), so
macOS Gatekeeper needs a one-time workaround per Mac. Everything below is
written for a friend with no build tooling installed — only macOS itself.

## 0. What you got

Two zip files, one per CPU architecture. Check which Mac you have:

- **Apple Silicon** (M1/M2/M3/M4 — any Mac from late 2020 onward):
  `KnockDesk-3.1.12-macOS-arm64.zip`
- **Intel** (older Macs): `KnockDesk-3.1.12-macOS-x64.zip`

Either zip runs on macOS **Big Sur (11) or newer**. If you are unsure which
arch you have: Apple menu → About This Mac → "Chip" or "Processor".

## 1. Unzip correctly

Double-clicking in Finder (Archive Utility) works. If you prefer the terminal:

```sh
cd ~/Downloads
ditto -x -k KnockDesk-3.1.12-macOS-arm64.zip .   # or the x64 zip
```

You should end up with `KnockDesk.app`. If your unzip tool shows thousands of
files but no `KnockDesk.app` folder, the tool flattened the bundle — use
Archive Utility or `ditto` instead. Do **not** use "The Unarchiver" with
"default" settings without checking the app still looks like one file.

## 2. Get past Gatekeeper (unsigned app)

On first double-click you will see *"KnockDesk can't be opened because Apple
cannot check it for malicious software"* (or "is damaged" on macOS 15+).
That is the missing signature, expected for this build. Either:

**Option A (GUI):** Right-click `KnockDesk.app` → **Open** → **Open** in the
dialog. If the dialog only offers "Move to Trash", use Option B.

**Option B (terminal, always works):**

```sh
xattr -cr ~/Downloads/KnockDesk.app       # or wherever it is
open ~/Downloads/KnockDesk.app
```

If macOS Sequoia/Tahoe (15+) reports "damaged", `xattr -cr` is required —
right-click Open alone may not clear it.

## 3. Automated sanity checks

Run the bundled script from the app's folder:

```sh
sh verify-macos.sh          # run it from next to KnockDesk.app
```

It checks (and prints PASS/FAIL for each):

1. `Contents/MacOS/KnockDesk` exists and is executable (0755)
2. Electron + helper frameworks have executable bits and valid Mach-O magic
3. `app.asar` present, `main.jsc` present
4. `better_sqlite3.node` matches your Mac's arch (`lipo -info`)
5. Bundled CPython 3.11 runs and reports the right arch
6. `venv/bin/hermes` is executable; `hermes --help` exits 0
7. `pyvenv.cfg` exists (it is rewritten in place on first launch)
8. Framework symlinks (`Electron Framework` → `Versions/A/...`) exist
9. Info.plist has `CFBundleIdentifier = app.knockdesk.desktop` and the
   usage-description strings

All PASS → the bundle is structurally sound and the Python runtime works.

## 4. First launch (the real test)

```sh
open ~/Downloads/KnockDesk.app
```

Expected on a healthy run:

1. The KnockDesk window appears within ~10 seconds.
2. The Hermes dashboard service starts in the background
   (`hermes dashboard --no-open` under the bundled venv). First launch may
   take a few extra seconds while the relocated venv is rewritten.
3. Activity Monitor should show a `python3.11` process spawned from inside
   `KnockDesk.app/Contents/Resources/hermes-runtime`.

### If the window opens but the agent does nothing

Check logs:

```sh
ls -la ~/Library/Logs/KnockDesk 2>/dev/null
ls -la ~/Library/Application\ Support/KnockDesk 2>/dev/null
```

Grab anything that looks like a log and send it back.

### Known-degraded on macOS (by design, parity with Windows)

- **Wake word listening** ("Hey Hermes" style always-on mic): the Python-side
  wake-word worker needs SpeechRecognition + pyaudio, which are not bundled on
  either platform. The Electron-side Porcupine path exists but treat mic wake
  word as untested on mac.
- **VAD / transcription / some media decoding** need macOS **14+ on Apple
  Silicon** and **13+ on Intel**: current onnxruntime/av wheels are only
  published for those floors (onnxruntime stopped shipping Intel wheels
  entirely, so Intel Macs use the last universal2 release). The core chat
  app itself still targets macOS 11.
- **uvloop**: not shipped (Windows-only wheel); the ASGI server falls back to
  asyncio. Invisible in practice.
- Agent-browser and WhatsApp-bridge **binaries** are not bundled; Hermes
  installs what it needs on first use (needs network).

## 5. Functional checklist (send results back)

| # | Test | Pass? |
|---|------|-------|
| 1 | App window opens from double-click (after §2) | |
| 2 | Agent replies in a chat (any provider configured) | |
| 3 | Settings → profile create/switch | |
| 4 | Local model probe: OPENAI_BASE_URL = `http://127.0.0.1:11434/v1` (if you run Ollama) shows models | |
| 5 | Screen capture prompt appears when screen tools used | |
| 6 | Microphone prompt appears when voice features used | |
| 7 | Quit from the menu actually exits (no zombie python) | |
| 8 | Second launch works without the xattr step again | |

## 6. Clean removal

Quit the app, then:

```sh
rm -rf ~/Downloads/KnockDesk.app
rm -rf ~/Library/Application\ Support/KnockDesk
rm -rf ~/Library/Caches/app.knockdesk.desktop 2>/dev/null
```

First quit any stray processes: Activity Monitor → search "KnockDesk" and
"python3.11" spawned from the app path → quit.

## 7. What "works" means here

- No crash on launch, agent responds, tools that need macOS permissions
  trigger the correct system prompts.
- Performance parity is NOT expected to be proven in this pass; it is a
  "does it run correctly on real hardware" gate before signing/notarizing.

## 8. After the test passes

The next step is code signing + notarization with the Apple Developer
account (rcodesign from this workspace, or a real Mac with codesign), then
the release zip is replaced with a signed one and the website /download card
goes live. Nothing in this test plan changes for the signed build except
§2 disappears entirely.
