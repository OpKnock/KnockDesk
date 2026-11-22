<p align="center">
  <a href="https://github.com/OpKnock/KnockDesk">
    <img src="resources/public/logo.png" alt="KnockDesk logo" width="168" />
  </a>
</p>

<h1 align="center">KnockDesk</h1>

<p align="center">
  <strong>Your personal AI command center.</strong>
  <br />
  Voice, memory, agents, automation, and computer interaction — in one desktop workspace.
</p>

<p align="center">
  <a href="https://github.com/OpKnock/KnockDesk"><img src="https://img.shields.io/github/license/OpKnock/KnockDesk?style=flat-square" alt="License" /></a>
  <a href="https://github.com/OpKnock/KnockDesk/commits/main"><img src="https://img.shields.io/github/last-commit/OpKnock/KnockDesk?style=flat-square" alt="Last commit" /></a>
  <a href="https://github.com/OpKnock/KnockDesk/issues"><img src="https://img.shields.io/github/issues/OpKnock/KnockDesk?style=flat-square" alt="Open issues" /></a>
  <img src="https://img.shields.io/badge/Desktop-Windows%20%7C%20macOS-536DFE?style=flat-square" alt="Desktop platforms" />
</p>

<p align="center">
  <a href="https://www.knockdesk.work.gd">Website</a>
  · <a href="https://github.com/OpKnock/KnockDesk">Source</a>
  · <a href="CONTRIBUTING.md">Contributing</a>
  · <a href="SECURITY.md">Security</a>
  · <a href="LICENSE">License</a>
</p>

---

## Meet KnockDesk

KnockDesk brings the feel of a personal AI assistant into a desktop environment you can shape around the way you work. Talk to your assistant, build a persistent persona, use memory and skills, connect AI providers, follow agent activity, explore live information, and use supported tools to interact with your computer — all from one workspace.

Rather than treating AI as another isolated chat window, KnockDesk brings the assistant, its tools, its context, and its desktop experience together.

## What you can do

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Voice-first assistance</h3>
      Interact through supported speech workflows, including transcription and spoken responses. Configure voice preferences and use wake-word workflows where supported by your runtime.
    </td>
    <td width="50%" valign="top">
      <h3>A persona that feels personal</h3>
      Shape the assistant's character, behavior, and tone. Keep supported persona and memory files in local folders you can inspect and manage.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Persistent memory and skills</h3>
      Maintain supported memory across sessions and extend the assistant through skills, plugins, and connected tools.
    </td>
    <td width="50%" valign="top">
      <h3>AI providers in one workspace</h3>
      Connect supported providers such as Google Gemini, OpenRouter, Groq, OpenAI, and Moonshot/Kimi, then configure the provider needed for each workflow.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>AgentTown</h3>
      Follow agent roles and activity through a pixel-art office environment when the AgentTown runtime is enabled.
    </td>
    <td width="50%" valign="top">
      <h3>World Monitor</h3>
      Bring map-based context, headlines, and location-aware information into the workspace through supported monitoring sources.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Computer use</h3>
      Use supported computer-control workflows, including visual overlays and a HUD, with the required provider configuration and operating-system permissions.
    </td>
    <td width="50%" valign="top">
      <h3>A workspace that feels like yours</h3>
      Choose from themes such as Ember, Cyberpunk, Midnight, Mono, Rosé, Nous Blue, and classic teal, including large-type presentation options in the interface.
    </td>
  </tr>
</table>

## Built around your workflow

- **Personal by design.** Configure your assistant's persona and supported preferences rather than being locked into one default interaction style.
- **Extensible.** Use skills, plugins, runtime tools, and supported integrations to expand what the assistant can do.
- **Desktop-native experience.** KnockDesk combines an Electron desktop layer with a React interface and the Hermes agent runtime.
- **Context beyond chat.** AgentTown, monitoring tools, memory, and computer-use integrations add more ways to work with the assistant.
- **Control over connectivity.** Network modes let you choose how the packaged application handles outbound connections.
- **Local-first.** Supported profile files and data stores live on your computer, with clear distinctions between local features and integrations that send requests to external services.

## Get started

### Requirements

For source development, have the following installed:

- Windows 10/11 or a supported macOS environment
- Node.js 22 or later and npm
- Git and Git LFS
- Python 3.11 for maintenance checks and selected tooling
- A configured Hermes runtime/CLI and provider credentials for the runtime-backed features you use

### Clone and launch

**Windows — PowerShell**

```powershell
git lfs install
git clone https://github.com/OpKnock/KnockDesk.git
cd KnockDesk
git lfs pull
npm run dev
```

**macOS — Terminal**

Install Node.js 22+, Git, and Git LFS first. With Homebrew, install Git LFS using `brew install git-lfs`.

```bash
git lfs install
git clone https://github.com/OpKnock/KnockDesk.git
cd KnockDesk
git lfs pull
npm run dev
```

The development launcher prepares the locked Electron and web workspaces for the current operating system, compiles the Electron main process, starts the desktop renderer, and launches KnockDesk. Stop the development session by closing the app or pressing **Ctrl+C** in the launching terminal.

On macOS, install a native Hermes CLI when your workflow requires it, then set `KNOCKDESK_HERMES_EXE` to its absolute path. For example:

```bash
export KNOCKDESK_HERMES_EXE="$HOME/.local/bin/hermes"
npm run dev
```

Replace the example path with the actual path to your Hermes executable.

### Launch the packaged Windows app

If you have a packaged KnockDesk distribution, launch `KnockDesk.exe` or run its installer, then complete first-run setup. The packaged app and source development shell have different entry points, while sharing the KnockDesk product experience.

## Configure your AI

Some assistant, voice, and tool workflows use external AI or speech services.

1. Open **Settings → AI Engine**.
2. Add the API key for the provider you want to use.
3. Select **Save & Apply**.
4. Test the desired workflow.

Provider availability, pricing, free-tier access, quotas, and terms are determined by each service and may change. Keep API keys private: do not commit them to source control or include them in screenshots, logs, issues, or pull requests.

## Privacy, security, and network control

KnockDesk is **local-first, not automatically offline**. Supported profile files and local data stores remain on your computer by default. When you use cloud AI, speech services, monitoring sources, messaging integrations, remote bridges, or other connected tools, those features may send requests and related data to the services involved.

### Packaged-app network modes

The packaged application's Electron network guard supports these modes:

| Setting | Purpose |
|---|---|
| `KNOCKDESK_NET_MODE=strict` | Allow loopback and approved provider hosts while blocking other outbound destinations through the Electron session guard. This is the default mode. |
| `KNOCKDESK_NET_MODE=off` | Air-gapped mode: block network access except loopback. Cloud-connected features will not work. |
| `KNOCKDESK_NET_MODE=open` | Disable the Electron network guard and restore the previous network behavior. |
| `KNOCKDESK_ALLOW_HOSTS=example.com,api.example.org` | Add trusted hostnames to the strict-mode allowlist. |

For additional Windows-level control, `scripts/ops/firewall-outbound.ps1` provides firewall rules for KnockDesk and supported companion processes. It uses `-WhatIf` by default; inspect the proposed changes before applying rules with elevated permissions.

### Protection for packaged core files

The Windows installer protects selected packaged modules at rest. During installation, it creates a per-install key, encrypts protected archive entries using AES-256-GCM, and stores a DPAPI-wrapped key for the installing Windows user. At launch, the shim decrypts the protected content in memory and checks the integrity manifest.

This adds a layer of protection for packaged files at rest; it is not a guarantee against inspection by someone who controls the running machine. Continue to use trusted installers, protect credentials, and review the permissions granted to computer-use and remote integrations.

For security reporting instructions, see [SECURITY.md](SECURITY.md).

## Where KnockDesk stores data

Common Windows locations for supported local data include:

| Location | Typical contents |
|---|---|
| `%USERPROFILE%\Documents\KnockDesk Data\` | Persona files such as `SOUL.md`, supported memory files, and custom skills |
| `%USERPROFILE%\Documents\KnockDesk_Vault\` | The file vault |
| Platform application user-data directory | Local stores such as chats, contacts, notes, tasks, and settings |

Exact locations depend on the build and configuration. Review the relevant app settings and local folders before moving, backing up, or deleting data. Compatibility identifiers may be retained to migrate older profile data safely.

## Development

### Common commands

Run these from the repository root.

| Command | Purpose |
|---|---|
| `npm run dev` | Launch the KnockDesk source development environment |
| `npm test` | Run root build-pipeline tests |
| `npm run check:knockdesk` | Run KnockDesk checks and compile the Electron main process |
| `npm run check:privacy` | Scan selected first-party text files for privacy-sensitive data |
| `npm run check:secrets` | Run the first-party secret scan |
| `npm run test:maintenance` | Run maintenance-tool unit tests |
| `npm run inventory` | Generate a repository payload inventory |

Renderer, Python, build, and packaging workflows have additional checks. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution expectations and the repository's GitHub Actions workflows for CI details.

### Repository map

| Path | Purpose |
|---|---|
| `resources/hermes-runtime/src/electron/` | Electron main process, preload bridge, and runtime controllers |
| `resources/hermes-runtime/src/web/src/desktop/` | KnockDesk React desktop interface |
| `resources/hermes-runtime/src/web/src/` | Hermes management dashboard source |
| `resources/hermes-runtime/src/hermes_cli/` | Hermes CLI and Python runtime |
| `resources/hermes-plugins/` | Hermes and KnockDesk plugins |
| `resources/knockdesk-computer/` | Computer-use sidecar source |
| `resources/agent-town-dist/` | AgentTown standalone application output |
| `resources/app.asar` | Packaged Electron application archive |
| `resources/main.jsc` | Compiled V8 bytecode used by the packaged application |
| `resources/public/logo.png` | KnockDesk logo asset |
| `scripts/` | Build, test, maintenance, privacy, security, and archive tools |
| `docs/BUILD_AND_SOURCE_MAP.md` | Source and packaged-artifact architecture reference |
| `NOTICE.md` | Third-party attribution inventory and license references |

## Credits and license

KnockDesk builds on upstream and third-party projects, including Hermes-Agent, Electron/Chromium, Node.js, Python, React, AgentTown, Baileys, Tesseract OCR, Playwright, and other libraries, native modules, and assets.

KnockDesk-authored first-party code identified as such is licensed under the **Apache License 2.0**; see [LICENSE](LICENSE). Third-party components retain their own licenses and notices. The root license does not replace upstream terms, including the MIT license for the Hermes-Agent source tree. Review [NOTICE.md](NOTICE.md) and the applicable component license files before redistributing.

---

<p align="center">
  Built by <a href="https://github.com/OpKnock">OpKnock</a>
  <br />
  <sub>KnockDesk — your AI, in your workspace.</sub>
</p>
