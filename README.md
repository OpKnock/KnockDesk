# KnockDesk

**A JARVIS-inspired AI workspace with a maintained Windows/macOS source shell.**

KnockDesk is a local-first desktop assistant that brings voice interaction, configurable personas, persistent memory, skills, resident agents, world-monitoring tools, and computer-use capabilities into one workspace. It is designed to feel personal while helping you get practical work done on your computer.

**Windows 10/11 and macOS source shell · Open source · Provider API costs may apply**

> **Build note:** The repository contains a maintained source-owned desktop shell as well as a separately preserved legacy packaged application. The source build is under active stabilization and is not yet certified as a feature-for-feature replacement for every screen and integration in the packaged app. See [Product Readiness](docs/PRODUCT_READINESS_AUDIT.md).

## What you can do with KnockDesk

### Voice assistant

Talk to your assistant using the voice and speech pipeline supported by your configured runtime. Voice workflows can include wake-word detection, speech transcription, spoken responses, and conversational context. Availability depends on the build, runtime, credentials, and speech services you configure.

### Persona, memory, and skills

Shape how your assistant behaves and what it can do:

- **Persona:** Customize its character, tone, and preferences through its persona configuration.
- **Memory:** Keep supported memory files and conversation-related data across sessions.
- **Skills:** Use installed skills and tools to carry out supported tasks.
- **Settings:** Inspect configuration and manage provider credentials from the app's settings.

Persona and memory files are designed to remain accessible on your own computer, so you can inspect and manage them rather than treating the assistant as a black box.

### AgentTown

The AgentTown workspace presents AI agents as a small pixel-art office, with agents, roles, and activity indicators. Where the AgentTown runtime and required integrations are available, it provides a more visual way to follow agent work. Availability can differ between the packaged application and the maintained source build.

### World Monitor

KnockDesk can include an interactive map and news-monitoring tools that help bring location-based context and headlines into the workspace. These features depend on the external sources and services configured for the build; feeds and availability may change.

### Computer control

Supported computer-use workflows can interact with on-screen content through a visual overlay and HUD. Computer control requires the relevant AI provider configuration and operating-system permissions. Review actions before granting control, and avoid giving automation access to sensitive accounts or data unless necessary.

### Command-center themes

Choose a look that suits your workspace. Built-in themes include **Ember**, **Cyberpunk**, **Midnight**, **Mono**, **Rosé**, **Nous Blue**, and the classic teal theme, with a large-type variation also available in the interface.

## API keys and providers

Some features depend on third-party AI or speech services. Depending on the integration, KnockDesk can use providers such as Google Gemini, OpenRouter, Groq, OpenAI, or Moonshot/Kimi.

1. Open **Settings → AI Engine**.
2. Add the key for the provider required by the feature you want to use.
3. Select **Save & Apply**, then test that feature.

Provider access, quotas, pricing, and terms are controlled by each provider and may change. A free provider tier, where available, is not guaranteed. Provider requests leave your computer and are subject to that provider's privacy policy and service terms.

## Quick start

### Run the packaged Windows application

On Windows 10 or Windows 11, launch `KnockDesk.exe` from a trusted project distribution. Follow the first-run onboarding, configure the providers required for your desired features, and start the assistant from the main interface.

This repository does not currently publish assets through GitHub Releases. If you do not already have a packaged build, use the source setup below.

### Run the maintained desktop shell from source

The maintained source shell can run on Windows or macOS. The separately preserved legacy `KnockDesk.exe` package is Windows-only.

**Requirements**

- Windows 10 or Windows 11, or a macOS version supported by Electron 44
- Node.js 22 or later and npm
- Git and Git LFS for repository payloads
- Python 3.11 for maintenance checks and selected tooling
- A configured Hermes runtime/CLI for runtime-backed assistant features

Clone the repository and retrieve LFS-managed files:

```powershell
git lfs install
git clone https://github.com/OpKnock/KnockDesk.git
cd KnockDesk
git lfs pull
```

Install and launch the development shell on Windows:

```powershell
npm run dev
```

On macOS, install Node.js 22+, Git, and Git LFS first. With Homebrew, Git LFS can be installed with `brew install git-lfs`. Then use Terminal:

```bash
git lfs install
git clone https://github.com/OpKnock/KnockDesk.git
cd KnockDesk
git lfs pull
npm run dev
```

The launcher installs the locked Electron and web workspaces for the current operating system, compiles the Electron main process, starts the desktop renderer, and launches Electron. Close the app or press **Ctrl+C** in the terminal to stop it.

The maintained renderer smoke test runs on both Windows and macOS in CI. That verifies the shell can launch and render; it does **not** certify live Hermes/AgentTown services, full feature parity with the preserved Windows package, or a signed/notarized release. The bundled legacy Hermes virtual environment is not a portable macOS runtime. On macOS, install a native Hermes CLI separately and set `KNOCKDESK_HERMES_EXE` to its absolute path before launching, for example `export KNOCKDESK_HERMES_EXE="$HOME/.local/bin/hermes"`. Assistant and other runtime-backed features remain dependent on the runtime and provider configuration.

## Where your data lives

On a typical Windows setup, KnockDesk uses the following locations for supported local data:

- `%USERPROFILE%\Documents\KnockDesk Data\` — persona files such as `SOUL.md`, memory files, and custom skills.
- `%USERPROFILE%\Documents\KnockDesk_Vault\` — the file vault.
- The platform's application user-data directory — local stores such as chats, contacts, notes, tasks, and settings.

Exact paths and stored data can vary by build and configuration. Check the relevant app settings and local files on your machine.

## Privacy and security

KnockDesk is **local-first, not universally offline**.

Local files and supported runtime data are stored on your computer by default. However, voice transcription, AI responses, news/map tools, messaging integrations, remote/mobile bridges, and other enabled integrations may communicate with external providers or services. Data sent by those features is subject to the destination service's policies.

API keys are configured locally for use by the integrations you enable, but they are used in provider requests. Treat them as secrets, keep them out of screenshots and logs, and never commit them to source control. Pair remote devices only when you trust the connection and understand which relay or service is involved.

The repository includes privacy and secret scans, but no automated scan can guarantee that every binary, generated artifact, upstream component, or historical reference is free of sensitive information. For vulnerability reporting, follow [SECURITY.md](SECURITY.md).

## Development and validation

Run the repository checks from the project root:

```powershell
npm test
npm run check:knockdesk
npm run check:privacy
npm run check:secrets
npm run test:maintenance
```

For source workspace checks, see the commands and requirements documented in the repository workflows and [CONTRIBUTING.md](CONTRIBUTING.md). GitHub Actions also checks selected builds, dependencies, LFS pointers, archive integrity, and Windows renderer startup.

Passing automated checks does not establish that every provider, voice device, native module, packaged screen, or optional service will work on every Windows machine. Review [docs/PRODUCT_READINESS_AUDIT.md](docs/PRODUCT_READINESS_AUDIT.md) before treating a build as production-ready.

## Repository map

| Path | Purpose |
|---|---|
| `resources/hermes-runtime/src/electron/` | Electron main process, preload bridge, and runtime controllers |
| `resources/hermes-runtime/src/web/src/desktop/` | Maintained KnockDesk React desktop interface |
| `resources/hermes-runtime/src/web/src/` | Hermes management dashboard source |
| `resources/hermes-runtime/src/hermes_cli/` | Hermes CLI and Python runtime source |
| `resources/hermes-plugins/` | Hermes and KnockDesk plugins |
| `resources/knockdesk-computer/` | Computer-use sidecar source |
| `resources/agent-town-dist/` | Built AgentTown standalone application |
| `resources/app.asar` | Preserved packaged Electron application archive |
| `resources/main.jsc` | Compiled V8 bytecode; not editable source |
| `resources/browsers/` | Browser and media runtime payloads |
| `scripts/` | Build, test, privacy, inventory, and unpacking utilities |
| `docs/BUILD_AND_SOURCE_MAP.md` | Source-versus-binary map and build guidance |
| `docs/PRODUCT_READINESS_AUDIT.md` | Verification coverage and remaining release gates |

## Open-source credits

KnockDesk builds on upstream projects and third-party components, including the Hermes-Agent runtime (MIT), Electron/Chromium, Node.js, Python, React, AgentTown, Baileys, Tesseract OCR, Playwright, and other libraries, assets, and native modules.

See [NOTICE.md](NOTICE.md) for the current attribution inventory and pointers to bundled license texts. The inventory is a review aid, not a complete release-specific software bill of materials; verify component versions and obligations before redistributing a build.

## License

KnockDesk-authored first-party code identified as such is licensed under the **Apache License 2.0**; see [LICENSE](LICENSE). Third-party components retain their own licenses and notices. The root license does not replace upstream terms, including the MIT license for the Hermes-Agent source tree. Read [NOTICE.md](NOTICE.md) and the applicable component license files before redistributing.
