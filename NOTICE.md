# KnockDesk Third-Party Notices

KnockDesk combines first-party application code with third-party runtimes, libraries, bundled applications, native modules, and binary assets. This notice is an attribution and release-review aid, not legal advice or a release-specific software bill of materials (SBOM).

**License scope:** The root Apache-2.0 license applies to KnockDesk-authored code identified as first-party. It does not override the MIT license retained by the Hermes-Agent source tree or the individual licenses and notices of other bundled components. A file's presence in this repository does not, by itself, make that file first-party or grant redistribution rights.

First-party KnockDesk code is licensed under the Apache License 2.0; see [LICENSE](LICENSE). Third-party components retain their own terms. Keep applicable upstream copyright notices, license texts, and attribution files when modifying or redistributing those components.

**Version note:** versions below are recorded in the current repository inventory or package metadata. They must be reconciled against the exact release payload before distribution.

## 1. Runtime and platform components

| Component | Recorded location / version | License or notice | Upstream |
|---|---|---|---|
| Electron | Maintained source shell: 44.7.2 in `resources/hermes-runtime/src/electron/package.json`; the legacy Windows package has a separate version that must be confirmed from the exact release payload | MIT; see `LICENSE.electron.txt` and verify the exact shipped version | https://github.com/electron/electron |
| Chromium | Included through Electron and browser payloads | BSD-style and other component notices; see `LICENSES.chromium.html` and bundled notices | https://www.chromium.org |
| Node.js | `resources/bin/node.exe`; v22.11.0 recorded | MIT plus third-party notices; verify the exact shipped build | https://github.com/nodejs/node |
| Python | `resources/hermes-runtime/python/`; 3.11.15 recorded | PSF license; see the bundled Python license | https://www.python.org |
| Python | `resources/python-embedded/`; 3.11.9 recorded | PSF license; see the bundled Python license | https://www.python.org |
| agent-browser | `resources/bin/agent-browser.exe`; 0.31.1 recorded | Apache-2.0 recorded; verify against the executable/version | https://github.com/vercel-labs/agent-browser |
| Playwright browser payloads | `resources/browsers/` | Playwright and browser-specific notices apply | https://github.com/microsoft/playwright |

## 2. Hermes and bundled applications

| Component | Recorded location / version | Recorded license / review status | Upstream |
|---|---|---|---|
| Hermes-Agent runtime, CLI, gateway, and dashboard | `resources/hermes-runtime/src/`; 0.17.0 recorded | MIT; retain `resources/hermes-runtime/src/LICENSE` and upstream notices | https://github.com/NousResearch/Hermes-Agent |
| AgentTown standalone application | `resources/agent-town-dist/`; 0.4.1 recorded | MIT recorded; confirm exact upstream project, version, and license before release | https://github.com/geezerrrr/agent-town |
| WhatsApp bridge | `scripts/whatsapp-bridge/`; Baileys 7.0.0-rc.9 recorded | MIT recorded; verify exact package and license metadata | https://github.com/WhiskeySockets/Baileys |
| Computer-use sidecar | `resources/knockdesk-computer/`; Agent S / gui-agents 0.3.2 recorded | Apache-2.0 recorded; confirm exact sources and dependencies | https://github.com/simular-ai/Agent-S |
| Tesseract OCR | `resources/computer-runtime/tesseract/` | Apache-2.0 recorded; verify shipped build and required notices | https://github.com/tesseract-ocr/tesseract |
| FFmpeg | Bundled media/browser payloads | Exact build configuration and redistribution obligations require release review | https://ffmpeg.org |
| WorldMonitor views | External service | Controlled by the service operator; external terms apply | https://www.worldmonitor.app |

## 3. JavaScript and TypeScript dependency families

The repository and packaged application reference packages including `@google/genai`, `@google/generative-ai`, `@jitsi/robotjs`, `@mediapipe/tasks-vision`, `@picovoice/porcupine-node`, `@picovoice/pvrecorder-node`, `@supabase/supabase-js`, `axios`, `better-sqlite3`, `bytenode`, `clsx`, `cors`, `dotenv`, `electron-updater`, `exceljs`, `express`, `jimp`, `js-tiktoken`, `lucide-react`, `mammoth`, `mermaid`, `mime-types`, `node-record-lpcm16`, `open`, `pdf-parse`, `playwright`, `react`, `react-dom`, `react-markdown`, `recharts`, `remark-gfm`, `screenshot-desktop`, `systeminformation`, `tailwind-merge`, `@nous-research/ui`, `@observablehq/plot`, `@react-three/fiber`, `@tailwindcss/vite`, `@xterm/xterm` and its add-ons, `class-variance-authority`, `leva`, `motion`, `qrcode`, `react-router-dom`, `unicode-animations`, and Vite/TypeScript tooling.

The Hermes terminal UI also includes Ink, React, nanostores, `@nanostores/react`, undici, and unicode-animations. The repository contains a Hermes Ink fork.

These dependencies use a mix of MIT, Apache-2.0, BSD, ISC, and other terms. The list is not exhaustive and does not assert a license for every transitive dependency. The exact lockfiles and package-level `LICENSE`, `NOTICE`, and `package.json` files are the sources to use when assembling a release-specific inventory.

## 4. Python dependency families

The bundled Python environment references packages and package families including OpenAI and Anthropic SDKs, PyYAML and ruamel.yaml, Jinja2, Pydantic, PyJWT, requests, urllib3, httpx, FastAPI, Uvicorn, websockets, psutil, croniter, Markdown, prompt_toolkit, Rich, python-dotenv, certifi, pathspec, Pillow, pywin32, pywinauto, pyautogui, pyperclip, pytesseract, NumPy, openpyxl, aiohttp, Playwright, SpeechRecognition, and PyAudio.

Licenses vary and include MIT, Apache-2.0, BSD variants, PSF, MPL-2.0, and other terms. Use the exact embedded package metadata and license files rather than assuming one license applies to the complete runtime.

## 5. Binary and model/data assets

The distribution may include Chromium resources, FFmpeg, native Node/Python modules, trained model/data files, MediaPipe tasks, ONNX models, WASM runtimes, fonts, sound effects, and other assets. Their presence, license, provenance, and redistribution permissions must be validated at the release-artifact level. Do not assume that an asset is first-party merely because it is stored in this repository.

Helper executables such as `resources/elevate.exe` and `resources/swap-helper.exe` require documented source provenance and license review before redistribution.

## 6. Items requiring release-time review

Before producing a public or commercial binary release:

- **GSAP:** the recorded dependency refers to the GSAP Standard License. Review the applicable terms for the intended distribution and use.
- **FFmpeg:** verify the exact build configuration, enabled codecs, license implications, and bundled notices.
- **qrcode-terminal:** verify the license of the exact package/version included in the shipped artifact.
- **AgentTown and helper executables:** verify source provenance, project identity, exact version, license text, and required attribution.
- **Complete inventory:** regenerate package and binary manifests from the exact release payload and produce an SBOM. The versions in this file are not a substitute for that process.

## 7. License and notice files

The repository includes or references the following notice sources:

- `LICENSE` — KnockDesk first-party code under Apache-2.0.
- `LICENSE.electron.txt` — Electron license.
- `LICENSES.chromium.html` — Chromium and bundled Chromium third-party notices.
- `resources/hermes-runtime/src/LICENSE` — Hermes-Agent MIT license.
- `resources/hermes-runtime/python/LICENSE.txt` and `resources/python-embedded/LICENSE.txt` — bundled Python license texts.
- Individual packages and bundled applications may contain additional `LICENSE`, `NOTICE`, or copyright files.

This notice does not replace the licenses shipped with individual components. Retain and include all notices required by the applicable licenses when redistributing modified or repackaged builds.
