# Third-Party Notices

KnockDesk includes third-party runtimes, libraries, applications and binary assets. This file is an inventory to aid attribution and release review; it is not legal advice and must not be treated as a guarantee that every version or license has been independently verified. Where applicable, original license and notice files remain with the component or distribution.

KnockDesk first-party code is licensed under the Apache License 2.0; see LICENSE. Third-party components remain under their own licenses. Do not remove upstream copyright or attribution notices when modifying or redistributing those components.

## 1. Core runtimes and platforms

| Component | Recorded version / location | License or notice | Upstream |
|---|---|---|---|
| Electron | 32.x; application shell | MIT; LICENSE.electron.txt | https://github.com/electron/electron |
| Chromium | Included through Electron | BSD-style and bundled third-party notices; LICENSES.chromium.html | https://www.chromium.org |
| Node.js | v22.11.0; resources/bin/node.exe | MIT plus third-party notices; verify exact bundled build at release | https://github.com/nodejs/node |
| Python | 3.11.15; resources/hermes-runtime/python/ | PSF; resources/hermes-runtime/python/LICENSE.txt | https://www.python.org |
| Python | 3.11.9; resources/python-embedded/ | PSF; resources/python-embedded/LICENSE.txt | https://www.python.org |
| agent-browser | Recorded as 0.31.1; resources/bin/agent-browser.exe | Apache-2.0; verify exact bundled build at release | https://github.com/vercel-labs/agent-browser |

Version numbers above are carried forward from the repository's bundle inventory and must be reconciled against the actual shipped payloads before issuing a new release.

## 2. JavaScript and TypeScript packages

Package metadata and each package's own license file are the source of truth. This list records dependency families; transitive dependencies are not exhaustively enumerated here.

### Electron application and web dashboard

The distribution includes packages such as @google/genai, @google/generative-ai, @jitsi/robotjs, @mediapipe/tasks-vision, @picovoice/porcupine-node, @picovoice/pvrecorder-node, @supabase/supabase-js, axios, better-sqlite3, bytenode, clsx, cors, dotenv, electron-updater, exceljs, express, jimp, js-tiktoken, lucide-react, mammoth, mermaid, mime-types, node-record-lpcm16, open, pdf-parse, playwright, react, react-dom, react-markdown, recharts, remark-gfm, screenshot-desktop, systeminformation, tailwind-merge, @nous-research/ui, @observablehq/plot, @react-three/fiber, @tailwindcss/vite, @xterm/xterm and its add-ons, class-variance-authority, leva, motion, qrcode, react-router-dom, unicode-animations, and Vite/TypeScript build tooling.

These packages use a mix of MIT, Apache-2.0, BSD, ISC and other terms. Consult each exact package's package.json, license and notice files rather than inferring a license from the list above. Use lockfiles under resources/hermes-runtime/src/ and packaged dependency directories to verify the versions being shipped.

### Terminal UI

The Hermes terminal UI includes ink, ink-text-input, React, nanostores, @nanostores/react, undici and unicode-animations. The repository also contains a Hermes Ink fork. Refer to the licenses bundled with these sources.

## 3. Python packages

The bundled Hermes/Python runtime includes a broad set of third-party packages. Notable families include OpenAI/Anthropic SDKs, PyYAML and ruamel.yaml, Jinja2, Pydantic, PyJWT, requests/urllib3/httpx, FastAPI/Uvicorn, websockets, psutil, croniter, Markdown, prompt_toolkit, rich, python-dotenv, certifi, pathspec, Pillow, pywin32, pywinauto, pyautogui, pyperclip, pytesseract, NumPy, openpyxl, aiohttp, Playwright, SpeechRecognition and PyAudio.

The precise licenses vary and include MIT, Apache-2.0, BSD variants, PSF, MPL-2.0 and other terms. Embedded Python directories include installed package metadata and license files; use those package-level files and the exact runtime inventory for release attribution.

## 4. Bundled applications, tools and services

| Component | Recorded version / location | License or attribution | Upstream / note |
|---|---|---|---|
| Hermes-Agent runtime, CLI, gateway and dashboard | 0.17.0 recorded; resources/hermes-runtime/src/ | MIT; resources/hermes-runtime/src/LICENSE | https://github.com/NousResearch/Hermes-Agent |
| AgentTown standalone application | 0.4.1 recorded; resources/agent-town-dist/ | MIT recorded; verify upstream project and exact source license before release | https://github.com/geezerrrr/agent-town (verify) |
| WhatsApp bridge | Baileys 7.0.0-rc.9 recorded; scripts/whatsapp-bridge/ | MIT recorded | https://github.com/WhiskeySockets/Baileys |
| Computer-use sidecar | Agent S / gui-agents 0.3.2 recorded; resources/knockdesk-computer/ | Apache-2.0 recorded | https://github.com/simular-ai/Agent-S |
| Tesseract OCR | resources/computer-runtime/tesseract/ | Apache-2.0 recorded; verify bundled build and notices | https://github.com/tesseract-ocr/tesseract |
| Playwright browser payloads and FFmpeg | resources/browsers/ | Playwright and browser notices apply; confirm FFmpeg build licensing and redistribution rights | https://github.com/microsoft/playwright |
| WorldMonitor views | Remote service | Terms and rights are controlled by the service operator, not this repository | https://www.worldmonitor.app |
| Helper executables | resources/elevate.exe, resources/swap-helper.exe | Recorded as project helpers; verify source provenance and licensing before redistribution | Source provenance not yet documented |

## 5. Release-time license review

Resolve these items before publishing a commercial or public binary distribution:

- **GSAP:** the recorded dependency uses the GSAP Standard License, which is not a conventional permissive open-source license. Review the current license and intended usage.
- **FFmpeg:** verify the exact build configuration, enabled codecs, applicable notices and redistribution obligations.
- **qrcode-terminal:** the recorded dependency inventory did not establish a reliable license field; verify its exact bundled package and upstream terms.
- **AgentTown and helper executables:** confirm source provenance, exact license texts and required notices.
- **Version inventory:** regenerate dependency and binary manifests from the exact release artifact. This file contains carried-forward version data and is not a substitute for a release-specific SBOM.

## 6. License texts included in the distribution

- LICENSE — KnockDesk first-party code (Apache-2.0).
- LICENSE.electron.txt — Electron license.
- LICENSES.chromium.html — Chromium and bundled Chromium third-party notices.
- resources/hermes-runtime/python/LICENSE.txt — embedded Python license.
- resources/python-embedded/LICENSE.txt — standalone embedded Python license.
- resources/hermes-runtime/src/LICENSE — Hermes-Agent license.
- Playwright and other packages may carry additional NOTICE, LICENSE, or third-party notice files in their respective package directories.

Retain applicable upstream notices and license texts when distributing a modified or repackaged application. For the exact obligations of a component, consult that component's current license and legal documentation.
