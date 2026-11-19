# KnockDesk

KnockDesk is a local-first desktop AI assistant for Windows. It pairs an
Electron shell with the Hermes agent runtime: a chat dashboard, a messaging
gateway, long-term memory, scheduled jobs, mobile remote access, and an
AgentTown visualizer — all running on your own machine.

> **Status:** v3.1.12-local. This repository is the full app: launcher,
> runtime, sources, and validation scripts.

## Features

- **Chat dashboard** — conversation UI with an embedded terminal session,
  model picker, reasoning controls, and session history.
- **Messaging gateway** — connect chat platforms (Telegram, Discord, Slack,
  WhatsApp, Matrix, email, and more) to the same agent.
- **Mobile remote** — a phone companion app talks to the desktop over an
  encrypted local bridge relay.
- **Memory** — pluggable long-term memory providers plus local JSON stores
  for chats, contacts, notes, and tasks.
- **Computer use** — an opt-in sidecar that can operate the desktop
  (mouse/keyboard) with an on-screen overlay and HUD.
- **AgentTown** — a pixel-art visualizer that shows agents collaborating.
- **Voice** — wake-word detection and voice input support.
- **Automation** — scheduled cron jobs, skills, and a tool/plugin system.

## Quick start (prebuilt)

Requirements: Windows 10/11.

```powershell
.\KnockDesk.exe
```

The app creates its data on first run (see [Data & privacy](#data--privacy)).
For diagnostics, launch with the remote-debugging flag (development only):

```powershell
.\KnockDesk.exe --remote-debugging-port=9222 --remote-allow-origins=*
```

## Build from source (maintained components)

Requirements: Windows 10/11, Python 3.11, Node.js 22+.

**Important:** The checked-in TypeScript Electron entrypoint and Hermes web
dashboard have not been proven equivalent to the original packaged desktop UI.
Source builds must not replace `resources/main.jsc`, `resources/app.asar`,
or `KnockDesk.exe` until runtime feature parity is tested.

```powershell
# From the repository root: validate the staging build script
node --test scripts/build-pipeline.test.mjs
node build-electron-main.mjs --dry-run

# Compile the maintained Electron main-process sources to staging/
node build-electron-main.mjs

# Build the separate Hermes web dashboard (NOT the shipped desktop UI)
cd resources/hermes-runtime/src/web
npm install
npm run build
npm test
```

The Electron script stages JavaScript and hand-written CommonJS dependencies in
`staging/electron-main/dist/`; it does not produce a replacement `main.jsc`
or a distributable installer. The maintained Electron entrypoint loads the
Hermes dashboard over `http://127.0.0.1:9119` after its local backend starts;
for development it uses the Vite server on port 5173. This corrects the
API/token origin mismatch but does not recreate the shipped KnockDesk UI.
The Vite dashboard targets `hermes_cli/web_dist/`, which is served by
the Hermes Python dashboard. Replacing the packaged renderer requires
a separate compatibility migration.

## Validate

```bash
pip install -r scripts/requirements.txt
playwright install --with-deps chromium

python scripts/smoke_test.py --timeout 90
python scripts/health_check.py --port 9222
python scripts/uninstall_verify.py --run-uninstaller --keep-user-data
python scripts/inventory.py
```

Continuous integration runs lint, type checks, bundle-integrity checks, and
dependency audits on every push (see `.github/workflows/ci.yml`).

## Project layout

| Path | Contents |
|---|---|
| `KnockDesk.exe` | Electron launcher |
| `resources/app.asar` | Bundled renderer UI |
| `resources/main.jsc` | Compiled main process (source: `resources/hermes-runtime/src/electron/main.ts`) |
| `resources/hermes-runtime/src/web/` | Dashboard SPA source (Vite + React + Tailwind) |
| `resources/hermes-runtime/src/electron/` | Electron main-process source (TypeScript) |
| `resources/hermes-runtime/src/ui-tui/` | Terminal UI (Ink React, embedded via xterm) |
| `resources/hermes-runtime/src/agent/`, `gateway/`, `tools/` | Agent core, messaging gateway, tool implementations |
| `resources/hermes-runtime/src/hermes_cli/` | CLI, setup wizard, config and skin engine |
| `resources/hermes-runtime/src/skills/`, `plugins/` | Built-in skills and plugins |
| `resources/hermes-plugins/` | KnockDesk plugins: mobile platform (`knockdesk`), computer-use tool (`knockdesk-computer`), memory provider (`knockdesk-memory`) |
| `resources/knockdesk-computer/` | Computer-use sidecar source (`runner.py`, overlay) |
| `resources/agent-town-dist/` | Built AgentTown visualizer (Next.js standalone) |
| `resources/hermes-runtime/python/`, `venv/` | Embedded Hermes Python runtime |
| `resources/python-embedded/` | Standalone Windows Python distribution |
| `resources/bin/` | Bundled `node.exe` and `agent-browser` binary |
| `resources/browsers/` | Playwright browser builds |
| `resources/computer-runtime/` | Computer-use runtime (Tesseract OCR, venv) |
| `resources/public/` | Brand assets (logo PNG set + `.ico`) |
| `resources/wake_word_bg.py` | Wake-word background service |
| `scripts/` | `smoke_test.py`, `health_check.py`, `uninstall_verify.py`, `inventory.py` |
| `locales/` | Chromium locale packs |
| `docs/INVENTORY.md` | Generated full file inventory |

Large binaries (`*.exe`, `*.dll`, `*.pak`, `*.bin`, `*.dat`, `*.asar`,
`*.jsc`) are tracked with Git LFS — see `.gitattributes`.

## Data & privacy

Everything stays on your machine by default. On first run the app creates:

- Electron stores (chats, contacts, notes, tasks, settings, keys) in the
  platform user-data directory
- `Documents/KnockDesk Data/` — persona (`SOUL.md`), memory (`MEMORY.md`),
  custom skills
- `Documents/KnockDesk_Vault/` — file vault
- `%LOCALAPPDATA%/hermes/` — Hermes agent home (config, sessions, logs)

API keys you enter are stored locally. The mobile-bridge secret is generated
on-device and never leaves your machine except through the encrypted relay
you explicitly pair.

## Updates

This local build ships with automatic updates pointed at a disabled stub
feed. Releases are distributed as portable archives; the staged updater
swaps files in place while preserving shortcuts and install markers.

## Open-source credits

KnockDesk stands on many open-source projects — the Hermes agent runtime
(Nous Research, MIT), Electron/Chromium, Python, Node.js, React, AgentTown,
the WhatsApp bridge (Baileys), Tesseract OCR, Playwright, and more. See
**[NOTICE.md](NOTICE.md)** for the full attribution list and bundled
license texts.

## License

KnockDesk's own code is licensed under the **Apache License 2.0** — see
[LICENSE](LICENSE). Third-party components keep their own licenses; see
[NOTICE.md](NOTICE.md) for the full attribution list. Additional bundled
license texts ship with the distribution (`LICENSE.electron.txt`,
`LICENSES.chromium.html`, `resources/hermes-runtime/python/LICENSE.txt`,
`resources/python-embedded/LICENSE.txt`,
`resources/hermes-runtime/src/LICENSE`).
