# KnockDesk

**Your personal AI workspace for voice, memory, agents, and computer-assisted work.**

KnockDesk is a JARVIS-inspired desktop assistant built around a local-first approach. It brings a configurable assistant persona, persistent local files, AI-provider integrations, voice workflows, skills, agent tooling, and supported computer-use capabilities into one desktop workspace.

> [!IMPORTANT]
> **Project status: active stabilization.** This repository contains a maintained Electron/React source shell and a separately preserved legacy Windows application. The source shell is not yet verified as a feature-for-feature replacement for the packaged application. A successful build or CI smoke test does not mean every runtime, provider, native module, or legacy screen has been tested end to end. Read the [Product Readiness Audit](docs/PRODUCT_READINESS_AUDIT.md) before treating a build as a release.

[Website](https://www.knockdesk.work.gd) · [Repository](https://github.com/OpKnock/KnockDesk) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

## Contents

- [Highlights](#highlights)
- [Platform and release status](#platform-and-release-status)
- [Quick start](#quick-start)
- [AI provider setup](#ai-provider-setup)
- [Network and privacy controls](#network-and-privacy-controls)
- [Protected application files](#protected-application-files)
- [Local data](#local-data)
- [Development and tests](#development-and-tests)
- [Repository map](#repository-map)
- [Known limitations](#known-limitations)
- [Security reports](#security-reports)
- [Credits and licensing](#credits-and-licensing)

## Highlights

### Assistant, voice, and persona
- Configure the assistant's persona, character, and supported voice preferences.
- Use speech, transcription, and spoken-response workflows when the selected runtime and services are available.
- Connect supported AI providers using your own credentials.

### Memory and skills
- Keep supported persona, memory, and skill files in local folders you can inspect and manage.
- Extend workflows with installed skills, plugins, and runtime tools.
- Preserve existing profile preferences during supported migrations from legacy storage keys.

### Agent workspace and monitoring
- AgentTown provides a pixel-art office view of agents and their activity when its runtime is available.
- Supported World Monitor views can bring maps, headlines, and location-related context into the workspace. Availability depends on the external sources configured for the build.

### Computer use
- Supported computer-use workflows can interact with on-screen content through an overlay or HUD.
- Computer control depends on provider configuration, runtime support, and operating-system permissions. Review actions and grant only the permissions needed.

### Desktop experience
- Themes include Ember, Cyberpunk, Midnight, Mono, Rosé, Nous Blue, and classic teal.
- Ambient UI activity is throttled after inactivity to reduce idle CPU use and resumes when relevant activity occurs.
- Runtime startup and shutdown paths include recovery and child-process cleanup logic; integrations still need real-machine validation.

## Platform and release status

| Build | Status |
|---|---|
| Maintained source shell | Windows and macOS development/smoke-test paths are maintained. CI smoke tests validate shell startup and rendering, not every live integration. |
| Preserved packaged application | Windows-specific legacy application, including `KnockDesk.exe`, `resources/app.asar`, and compiled `resources/main.jsc`. |
| Signed distributable | Do not assume a build is signed, notarized, or ready for public distribution. Check the actual artifact and current readiness audit. |
| macOS production package | Not yet a signed/notarized feature-parity release. A native Hermes runtime must be configured separately where required. |

This repository does not currently publish downloadable application assets through GitHub Releases. Obtain packaged builds only from a distribution channel you trust.

## Quick start

### Requirements

- Windows 10/11 or a macOS version supported by the installed Electron toolchain
- Node.js 22 or later and npm
- Git and Git LFS
- Python 3.11 for maintenance checks and selected tooling
- A configured Hermes CLI/runtime for runtime-backed assistant features
- Provider credentials for cloud AI or speech services you choose to use

### Clone and launch

**Windows PowerShell**

```powershell
git lfs install
git clone https://github.com/OpKnock/KnockDesk.git
cd KnockDesk
git lfs pull
npm run dev
```

**macOS Terminal**

Install Node.js 22+, Git, and Git LFS first. With Homebrew, Git LFS can be installed with `brew install git-lfs`.

```bash
git lfs install
git clone https://github.com/OpKnock/KnockDesk.git
cd KnockDesk
git lfs pull
npm run dev
```

The development launcher prepares the locked Electron and web workspaces for the current operating system, compiles the Electron main process, starts the desktop renderer, and launches Electron. Close the app normally or press **Ctrl+C** in the launching terminal to stop the development session.

On macOS, install a native Hermes CLI separately if required, then point KnockDesk to its absolute path:

```bash
export KNOCKDESK_HERMES_EXE="$HOME/.local/bin/hermes"
npm run dev
```

Replace the example path with the actual Hermes executable path. The bundled legacy Hermes virtual environment is not a portable macOS runtime.

### Packaged Windows application

If you already have a trusted packaged distribution, launch `KnockDesk.exe` and complete first-run setup. Configure the provider/runtime required for the features you want to use. The packaged build may contain screens and integrations not yet reproduced in the maintained source shell.

## AI provider setup

Provider availability and labels vary by build. Supported integrations may include Google Gemini, OpenRouter, Groq, OpenAI, and Moonshot/Kimi.

1. Open **Settings → AI Engine**.
2. Add the API key required by the provider.
3. Select **Save & Apply** and test the feature.

Provider access, free-tier availability, quotas, pricing, and terms are controlled by each provider and can change. Requests sent to cloud providers leave your computer and are subject to that provider's policies. Never commit real API keys or include them in screenshots, logs, issues, or pull requests.

## Network and privacy controls

KnockDesk is **local-first, not universally offline**. Local files and supported runtime data are stored on your computer by default, but AI providers, speech services, messaging integrations, remote bridges, and monitoring sources may transmit data externally when enabled.

The packaged application's network guard supports these modes:

| Setting | Behavior |
|---|---|
| `KNOCKDESK_NET_MODE=strict` | Default allowlist mode: loopback and approved provider hosts are allowed; other outbound destinations are blocked by the Electron session guard. |
| `KNOCKDESK_NET_MODE=off` | Air-gapped mode: block network access except loopback. Cloud features will not work. |
| `KNOCKDESK_NET_MODE=open` | Disable the Electron network guard and use the previous network behavior. Use only if you understand the trade-off. |
| `KNOCKDESK_ALLOW_HOSTS=example.com,api.example.org` | Add approved hostnames in strict mode. Only add hosts you trust. |

The separate Windows firewall helper at `scripts/ops/firewall-outbound.ps1` can apply OS-level rules to the application and supported sidecar processes. It uses **WhatIf/dry-run behavior by default**; review its output and the script before applying firewall changes with elevated privileges. Strict and air-gapped modes can prevent integrations that require unlisted destinations from working.

Network controls are not a guarantee that every data path is covered in every build. Review runtime, provider, and integration behavior before handling sensitive information. See [SECURITY.md](SECURITY.md) and the [readiness audit](docs/PRODUCT_READINESS_AUDIT.md).

## Protected application files

The Windows installer includes at-rest protection for selected packaged core modules. It generates a per-install key, encrypts protected archive entries with AES-256-GCM, and stores a DPAPI-wrapped key for the installing Windows user. The launch shim decrypts protected content in memory and checks an integrity manifest.

**Understand the limits:** this is protection against casual offline inspection of a copied installation, not a promise that the owner, a local administrator, or a determined attacker controlling a running machine can never inspect the program. It does not replace code signing, secure update delivery, endpoint protection, or a full security review.

The compiled `resources/main.jsc` file is V8 bytecode, not the original TypeScript/JavaScript source. Unpacking the application archive can expose bundled files but cannot recreate missing source, source maps, or original component boundaries.

## Local data

Common Windows locations for supported local data include:

- `%USERPROFILE%\Documents\KnockDesk Data\` — persona files such as `SOUL.md`, supported memory files, and custom skills.
- `%USERPROFILE%\Documents\KnockDesk_Vault\` — the file vault.
- The platform's application user-data directory — local stores such as chats, contacts, notes, tasks, and settings.

Paths and stored data vary by build and configuration. Check app settings and local files before moving, backing up, or deleting data. The compatibility layer may retain legacy identifiers to migrate existing data; do not rename or delete these identifiers without understanding the migration contract.

## Development and tests

Run repository-level checks from the project root:

```powershell
npm test
npm run check:knockdesk
npm run check:privacy
npm run check:secrets
npm run test:maintenance
```

For renderer, Python, and additional workspace checks, follow [CONTRIBUTING.md](CONTRIBUTING.md) and the relevant GitHub Actions workflows.

Automated checks cover selected build contracts, source tests, privacy/secret scanning, dependency checks, Git LFS and packaged-artifact integrity, and source-renderer smoke tests on Windows and macOS. Smoke mode intentionally skips live Hermes and AgentTown sidecars. Passing tests does not prove every provider, voice device, native module, packaged screen, installer path, or external integration works on every machine.

Before making a release, review [docs/PRODUCT_READINESS_AUDIT.md](docs/PRODUCT_READINESS_AUDIT.md) and [docs/BUILD_AND_SOURCE_MAP.md](docs/BUILD_AND_SOURCE_MAP.md).

## Repository map

| Path | Purpose |
|---|---|
| `resources/hermes-runtime/src/electron/` | Maintained Electron main process, preload bridge, and runtime controllers |
| `resources/hermes-runtime/src/web/src/desktop/` | Maintained KnockDesk React desktop interface |
| `resources/hermes-runtime/src/web/src/` | Hermes management dashboard source |
| `resources/hermes-runtime/src/hermes_cli/` | Hermes CLI and Python runtime source |
| `resources/hermes-plugins/` | Hermes and KnockDesk plugins |
| `resources/knockdesk-computer/` | Computer-use sidecar source |
| `resources/agent-town-dist/` | Built AgentTown standalone application output |
| `resources/app.asar` | Preserved packaged Electron application archive |
| `resources/main.jsc` | Compiled V8 bytecode, not editable source |
| `resources/browsers/` | Browser and media runtime payloads |
| `scripts/` | Build, tests, privacy/security scans, inventory, and archive tooling |
| `scripts/rebrand/` | Compatibility shim, archive rebrand tooling, and identifier notes |
| `docs/BUILD_AND_SOURCE_MAP.md` | Editable source vs. packaged/generated payloads |
| `docs/PRODUCT_READINESS_AUDIT.md` | Test coverage, release gates, and known gaps |
| `NOTICE.md` | Third-party attribution inventory and license pointers |

## Known limitations

- The source-owned desktop shell is not yet verified as a feature-for-feature replacement for the preserved packaged app.
- Windows/macOS CI smoke tests validate the source shell and renderer, not live sidecars or all provider integrations.
- The legacy packaged executable is Windows-specific; macOS production packaging, signing, notarization, and end-to-end parity are not complete.
- Install, upgrade, uninstall, user-data retention, and clean-machine runtime checks remain important release gates.
- Some bundled components are generated output, native binaries, or third-party assets. Their original source and license obligations may be separate from KnockDesk's first-party code.
- The third-party inventory is a review aid, not a complete release-specific software bill of materials. Verify versions, provenance, and obligations before redistribution.

## Security reports

Do not publish unpatched vulnerabilities, credentials, tokens, or private user data in public issues. Follow the private-reporting guidance in [SECURITY.md](SECURITY.md).

## Credits and licensing

KnockDesk builds on upstream projects and third-party components, including Hermes-Agent, Electron/Chromium, Node.js, Python, React, AgentTown, Baileys, Tesseract OCR, Playwright, and other libraries, native modules, and assets.

KnockDesk-authored first-party code identified as such is licensed under the **Apache License 2.0**; see [LICENSE](LICENSE). Third-party components retain their own licenses and notices. The root license does not replace upstream terms, including the MIT license for the Hermes-Agent source tree. Review [NOTICE.md](NOTICE.md) and applicable component license files before redistributing.

---

Maintained by [OpKnock](https://github.com/OpKnock).
