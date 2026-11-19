# KnockDesk — Open Source Notices

KnockDesk is built on the work of many open-source projects. This file
credits the third-party components distributed with the application, as
required by their licenses. Unless stated otherwise, all licenses below are
permissive (MIT / Apache-2.0 / BSD / ISC / PSF) and bundled license texts
ship alongside the app where noted.

> Version pins below reflect the distributed build (app v3.1.12-local).
> Entries marked *(verify at release)* were read from upstream registry
> metadata rather than a file in this snapshot — re-confirm before
> publishing a release.

## 1. Core platforms and runtimes

| Component | Version | License | Upstream |
|---|---|---|---|
| Electron (application shell) | 32.x | MIT — full text in `LICENSE.electron.txt` | https://github.com/electron/electron |
| Chromium (renderer, via Electron) | see bundled notice | BSD-style — full text in `LICENSES.chromium.html` (11 MB) | https://www.chromium.org |
| Node.js (`resources/bin/node.exe`) | v22.11.0 | MIT + third-party notices (see nodejs.org) *(verify at release)* | https://github.com/nodejs/node |
| Python 3.11 — Hermes runtime (`resources/hermes-runtime/python/`) | 3.11.15 | PSF License — full text in `resources/hermes-runtime/python/LICENSE.txt` | https://www.python.org |
| Python 3.11 — embedded (`resources/python-embedded/`) | 3.11.9 | PSF License — full text in `resources/python-embedded/LICENSE.txt` | https://www.python.org |
| agent-browser (`resources/bin/agent-browser.exe`) | 0.31.1 | Apache-2.0 *(verify at release)* | https://github.com/vercel-labs/agent-browser |

## 2. JavaScript libraries (direct dependencies)

### Desktop app shell
MIT unless noted: `@google/genai` + `@google/generative-ai` (Apache-2.0),
`@jitsi/robotjs`, `@mediapipe/tasks-vision` (Apache-2.0),
`@picovoice/porcupine-node` + `@picovoice/pvrecorder-node` (Apache-2.0),
`@supabase/supabase-js`, `axios`, `better-sqlite3`, `bytenode`, `clsx`,
`cors`, `dotenv` (BSD-2-Clause), `electron-updater`, `exceljs`, `express`,
`jimp`, `js-tiktoken`, `lucide-react` (ISC), `mammoth` (BSD-2-Clause),
`mermaid`, `mime-types`, `node-record-lpcm16` (ISC), `open`,
`pdf-parse` (Apache-2.0), `playwright` (Apache-2.0 — its own NOTICE ships
in its package), `react` + `react-dom`, `react-markdown`, `recharts`,
`remark-gfm`, `screenshot-desktop`, `systeminformation`, `tailwind-merge`.

### Web dashboard
MIT unless noted: `@nous-research/ui`, `@observablehq/plot` (ISC),
`@react-three/fiber`, `@tailwindcss/vite` + `tailwindcss`,
`@xterm/xterm` + `addon-fit` + `addon-unicode11` + `addon-web-links` +
`addon-webgl`, `class-variance-authority` (Apache-2.0), `clsx`,
`tailwind-merge`, `leva`, `lucide-react` (ISC), `motion`, `qrcode`,
`react` + `react-dom` + `react-router-dom`, `unicode-animations`,
`@streamdown/math` (Apache-2.0), `agent-browser` (Apache-2.0);
dev: `three`, `vite`, `vitest`, `eslint`, `typescript` (Apache-2.0).

> ⚠️ `gsap` ships under a non-SPDX "Standard 'no charge'" license
> (https://gsap.com/standard-license). Flagged for legal review before
> any commercial distribution.

### Terminal UI (Ink-based)
`ink`, `ink-text-input`, `react`, `nanostores` + `@nanostores/react`,
`undici`, `unicode-animations` (all MIT); `@hermes/ink` is a first-party
fork bundled with the Hermes sources.

### Build tooling
`electron` (MIT), `bytenode` (MIT), `tsx` (MIT), `typescript` (Apache-2.0).

## 3. Python packages (Hermes core, exact pins)

MIT unless noted: `openai`, `pyyaml`, `ruamel.yaml`, `Jinja2`
(BSD-3-Clause), `pydantic`, `packaging` (Apache-2.0/BSD), `PyJWT`,
`urllib3`, `concurrent-log-handler`, `fire` (Apache-2.0),
`requests` (Apache-2.0), `tenacity` (Apache-2.0), `psutil`
(BSD-3-Clause), `websockets` (BSD-3-Clause), `tzdata` (Apache-2.0),
`croniter`, `Markdown` (BSD-3-Clause), `prompt_toolkit` (BSD-3-Clause),
`rich`, `fastapi`, `uvicorn[standard]` (BSD-3-Clause), `python-multipart`,
`pywinpty`, `python-dotenv` (BSD-3-Clause), `certifi` (MPL-2.0),
`pathspec` (MPL-2.0), `httpx` (BSD-3-Clause), `Pillow` (HPND),
`pywin32` (PSF), `pywinauto` (BSD-3-Clause), `pyautogui` (BSD-3-Clause),
`pyperclip` (BSD-3-Clause), `pytesseract` (Apache-2.0), `tiktoken`,
`backoff`, `numpy` (BSD-3), `anthropic` (Apache-2.0), `mypy` (MIT),
`ruff` (MIT), `openpyxl`, `aiohttp` (Apache-2.0), `playwright`
(Apache-2.0).

Speech (wake-word background service): `SpeechRecognition`
(BSD-3-Clause), `PyAudio` (MIT).

## 4. Bundled applications and services

| Component | Version | License | Upstream |
|---|---|---|---|
| Hermes-Agent runtime + CLI + gateway + dashboard sources (`resources/hermes-runtime/src/`) | 0.17.0 | MIT © 2025 Nous Research — full text in `resources/hermes-runtime/src/LICENSE` | https://github.com/NousResearch/Hermes-Agent |
| AgentTown visualizer (`resources/agent-town-dist/`, Next.js standalone) | 0.4.1 (`@geezerrrr/agent-town`) | MIT *(upstream repo URL to verify at release)* | https://github.com/geezerrrr/agent-town *(to verify)* |
| WhatsApp bridge (`scripts/whatsapp-bridge/`, Baileys-based) | Baileys 7.0.0-rc.9 (pinned commit) | MIT | https://github.com/WhiskeySockets/Baileys |
| Computer-use sidecar (`resources/knockdesk-computer/`, Agent S3 `gui-agents`) | 0.3.2 | Apache-2.0 | https://github.com/simular-ai/Agent-S |
| Tesseract OCR (`resources/computer-runtime/tesseract/`) | bundled | Apache-2.0 | https://github.com/tesseract-ocr/tesseract |
| Playwright browsers (Chromium/FFmpeg in `resources/browsers/`) | chromium-1208, ffmpeg-1011 | Apache-2.0 (Playwright) + browser licenses — ⚠️ FFmpeg build licensing to confirm for redistribution | https://github.com/microsoft/playwright |
| WorldMonitor views | remote service | Views load from `worldmonitor.app`; all rights belong to their operator *(verify terms before release)* | https://www.worldmonitor.app |
| Helper binaries (`resources/elevate.exe`, `resources/swap-helper.exe`) | first-party | covered by this project's license *(provenance to confirm at release)* | — |

> ⚠️ `qrcode-terminal` (WhatsApp bridge dependency) publishes no license
> field upstream — replace or confirm before release.

## 5. First-party KnockDesk components (this project)

Electron main process (`resources/hermes-runtime/src/electron/`), Hermes
plugins (`resources/hermes-plugins/knockdesk/`,
`knockdesk-computer/`, `knockdesk-memory/`), computer-use sidecar
(`resources/knockdesk-computer/`), wake-word service
(`resources/wake_word_bg.py`), validation scripts (`scripts/`), and the
KnockDesk brand assets (`resources/public/`) are the project's own work.

## 6. License texts shipped in this distribution

- `LICENSE.electron.txt` — Electron (MIT)
- `LICENSES.chromium.html` — Chromium (BSD-style)
- `resources/hermes-runtime/python/LICENSE.txt` — Python (PSF)
- `resources/python-embedded/LICENSE.txt` — Python (PSF)
- `resources/hermes-runtime/src/LICENSE` — Hermes-Agent (MIT)
- Playwright's own `NOTICE` + `ThirdPartyNotices.txt` inside its package
