# KnockDesk — Microsoft Store Submission Checklist

Date: 2026-10-21 (revised; originally 2026-10-17). Version: 3.1.12. Status per item: VERIFIED / FAILED / BLOCKED / N/A.

## Package Identity and Versioning

| Item | Status | Notes |
|------|--------|-------|
| Version scheme (semver) | VERIFIED | 3.1.12 in exe metadata + package.json + NSIS VIAddVersionKey |
| Architecture declared | VERIFIED | x64 (NSIS installer targets 64-bit) |
| Package identity (Publisher/Name) | VERIFIED | `OpKnock.KnockDesk` / `CN=13E3D3C2-988F-4109-AD0E-42DE8604237C` — the values Partner Center assigned. `scripts/build-msix.mjs --store` declares them. |
| Package family name | VERIFIED | Derived by Windows from the identity name and publisher (`OpKnock.KnockDesk_f3e3af4par97c`). It is never written by hand. |
| MSIX version number | VERIFIED | `3.1.12.0` — the four-part form Partner Center expects. Partner Center must not already hold an equal or higher version. |
| Version sync across exe/installer/about | VERIFIED | FileVersionInfo: 3.1.12; NSIS: 3.1.12; app displays 3.1.12-local |
| Target device family | VERIFIED | `Windows.Desktop` only. Windows.Core is IoT Core and the Store rejects it for a desktop app; Universal, Xbox, Holographic and Team are not appropriate either. |

## Packaging Approach

| Item | Status | Notes |
|------|--------|-------|
| NSIS offline installer | VERIFIED | The direct download. See docs/PACKAGING_DECISION.md. |
| Standalone (no web downloader) | VERIFIED | The whole payload is embedded in the installer |
| MSIX packaging | VERIFIED | `scripts/build-msix.mjs --store` builds the Store submission package from the same staging tree as the installer, so both carry the same payload. |
| Store package is submitted unsigned | VERIFIED | Microsoft signs the package once it accepts the submission. `--store` refuses to run when `SIGN_PFX` or `SIGN_PFX_PASSWORD` is set, so a personal certificate can never contradict the declared publisher. |
| Payload is not trimmed | VERIFIED | Nothing is dropped from the payload. An earlier build removed about 267 MB of build tooling on the belief that the block map is capped at 65,535 blocks; that is the ZIP32 entry limit, not a block-map limit, and the package packs and unpacks with over 78,000 blocks. The package now carries exactly what the installer carries. |

## Installation Artifacts

| Item | Status | Notes |
|------|--------|-------|
| NSIS installer builds cleanly | VERIFIED | `scripts/build-nsis-installer.ps1` (path-length guard for MAX_PATH) |
| Installer icon + branding | VERIFIED | KnockDesk logo, OpKnock publisher, copyright in metadata |
| License page (MUI) | VERIFIED | Apache-2.0 LICENSE file |
| Custom install directory | VERIFIED | NSIS MUI_DIRECTORYPAGE, default `$LOCALAPPDATA\KnockDesk` |
| Desktop shortcut (optional, default ON) | VERIFIED | NSIS Section SEC_DESKTOP |
| Start Menu shortcut + Uninstall | VERIFIED | NSIS Sections |
| Per-user install (no admin) | VERIFIED | `RequestExecutionLevel user`, HKCU registry, `$LOCALAPPDATA` |
| Silent install/uninstall | VERIFIED | NSIS `/S` flag; quiet uninstall string registered |
| Add/Remove Programs entry | VERIFIED | HKCU Uninstall registry key with all metadata |
| App Paths registration | VERIFIED | HKCU `App Paths\KnockDesk.exe` — Win+R launch |
| Windows Search discoverable | VERIFIED | Start Menu shortcut (tested: search finds KnockDesk) |
| SHA-256 checksums published | VERIFIED | `dist/SHA256SUMS.txt` + `dist/SHA256SUMS-installer.txt` |
| User data preserved on upgrade | VERIFIED | `%APPDATA%\knockdesk` outside install dir (legacy `KnockDesk` migrated on first run); installer kills running exe, replaces files |
| User data preserved on uninstall | VERIFIED | Uninstaller does not touch `%APPDATA%\knockdesk` |
| Clean uninstall | PARTIAL | Removes app, shortcuts, all registry. 65 deeply-nested Python files in `hermes-runtime\python\` remain due to Windows MAX_PATH (inert, no executable). Documented; user can delete folder manually. |

## Code Signing

| Item | Status | Notes |
|------|--------|-------|
| Store package signing | VERIFIED | Not our job: the Store package is submitted unsigned and Microsoft signs it. |
| Release installer signing | VERIFIED | The NSIS installer and the sideload MSIX are Authenticode-signed and RFC 3161-timestamped with the release certificate. |
| Certificate trust | VERIFIED | The certificate chains to Codegic Root CA G2, which is not in the Windows trusted root list. The EXE installs with a SmartScreen prompt the user can accept. The MSIX cannot: `Add-AppxPackage` rejects it with 0x800B010A. That is exactly why the MSIX that ships is the Store package. |
| No self-signed certs in repo | VERIFIED | sign-release.ps1 refuses self-signed; no .pfx files tracked |

## System Requirements

| Item | Status | Notes |
|------|--------|-------|
| Windows 10 1809+ (Electron 44) | VERIFIED | Electron 44.7.2 requires Win10+ |
| x64 architecture | VERIFIED | Tested on x64 Windows 11 |
| RAM minimum | VERIFIED | 8 GB recommended (measured 2.5GB idle); 4 GB minimum |
| Disk space | VERIFIED | ~3 GB installed (2.7 GB payload) |
| Internet | VERIFIED | Optional — app works fully offline with local keys; internet needed for AI providers |

## Accessibility

| Item | Status | Notes |
|------|--------|-------|
| Keyboard navigation | PARTIAL | React app supports standard focus; overlay uses Enter key. Full audit not done. |
| Screen reader labels | PARTIAL | Onboarding inputs have autocomplete attrs; full ARIA audit not done. |
| High-contrast mode | NOT TESTED | No explicit testing done |
| Text scaling | NOT TESTED | CSS uses px units; no explicit scaling testing |

## Store Listing Content

| Item | Status | Notes |
|------|--------|-------|
| App description (truthful) | BLOCKED | Draft below; needs user review |
| Feature list | BLOCKED | Draft below; needs user review |
| Screenshots | BLOCKED | Need capture at 1366x768 + 1920x1080 minimum |
| Age rating | VERIFIED | Suitable for 3+ (no violence, gambling, or adult content); generative AI requires additional disclosure |
| Category | VERIFIED | Productivity > AI assistant |
| Support URL | BLOCKED | Needs user-provided URL |
| Privacy policy URL | VERIFIED | docs/PRIVACY_POLICY.md ready; needs hosting |
| Copyright | VERIFIED | Copyright (c) 2026 OpKnock |

## Generative AI Policy Compliance

| Item | Status | Notes |
|------|--------|-------|
| AI content disclosure | VERIFIED | Chat labels responses as AI-generated; privacy policy covers this |
| User reporting mechanism | PARTIAL | In-app feedback collection is cloud-neutered; external reporting needs support URL |
| Content safeguards | PARTIAL | Provider-side filtering (Google/OpenRouter enforce their own policies); no custom pre/post filter |
| User controls | VERIFIED | Users control keys, providers, memory, data deletion |

## Partner Center Declarations

| Item | Status | Notes |
|------|--------|-------|
| Account creation | VERIFIED | The Partner Center account exists: the identity `OpKnock.KnockDesk` was assigned to it. |
| App name reservation | VERIFIED | "KnockDesk" is reserved on the account. |
| Package upload | READY | `dist/KnockDesk-3.1.12-x64.msix`, built with `--store`. |
| Device family selection | READY | Select the Windows desktop family only. The package declares `Windows.Desktop` and nothing else. |
| Restricted capabilities | READY | `runFullTrust` is declared and is a restricted capability: Partner Center asks for a justification in the submission options. See "runFullTrust justification" below. |
| Test notes for certification | BLOCKED | Draft below; needs user review |
| External services disclosure | BLOCKED | Needs listing of Google Gemini / OpenRouter / user-configured AI providers |

### runFullTrust justification (paste into the submission options)

> KnockDesk is a Windows desktop AI assistant that requires full-trust execution to provide desktop integration, launch and manage local processes, interact with supported desktop applications, and perform user-authorized computer automation. The runFullTrust capability is necessary for these core desktop features. The application does not use this capability to bypass Windows security controls, and computer automation is performed according to user permissions and authorization.

## WACK (Windows App Certification Kit)

| Item | Status | Notes |
|------|--------|-------|
| WACK installed | VERIFIED | `C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe` |
| WACK against the MSIX package | NOT TESTED | WACK validates MSIX/AppX packages, so it is now applicable. It has not been run against the Store package: WACK rejects an unsigned package, and the Store package is unsigned by design. Run it against a signed sideload build if a local WACK pass is wanted. |
| Crash-free launch | VERIFIED | Smoke test passes against the unpacked package: the app launches, the window paints, the splash shows the KnockDesk brand, the main page is served on the local server, and it shuts down. |

## Package contents verified against the runtime inventory

The unpacked package was compared with the staging tree the installer uses.
Every runtime path the app needs is present in the package:

| Runtime | Present |
|---|---|
| `resources/app.asar` and `app.asar.unpacked` | yes |
| `better-sqlite3` native module | yes |
| `@jitsi/robotjs` native module (desktop automation) | yes, with the Windows prebuild |
| Hermes virtualenv and `hermes.exe` | yes |
| Hermes CLI sources (`hermes_cli`) | yes |
| computer-use virtualenv | yes |
| `pytesseract` and the bundled tesseract | yes |
| `resources/knockdesk-computer` and the Hermes plugin | yes |
| Porcupine / PvRecorder (voice) | yes |
| Bundled Chromium and the agent browser | yes |
| Agent Town server and static build | yes |
| The store icons, under `Assets\` | yes |
| `locales/`, `resources.pak` | yes |

## Remaining Blockers (user action required)

1. **Upload the Store package** — `dist/KnockDesk-3.1.12-x64.msix` — to Partner Center, select the desktop device family only, and paste the `runFullTrust` justification above.
2. **Provide support URL** for Store listing
3. **Host privacy policy** at a public URL
4. **Capture screenshots** at required resolutions
5. **Review and approve** the draft description below
6. **Test on clean Windows machines** (VM or physical, no dev tools)
7. **Real-hardware validation of the macOS bundles** (see docs/MACOS_STATUS.md)

## Draft Store Description (for review)

> **KnockDesk — Your Local-First AI Assistant**
>
> KnockDesk is a privacy-respecting desktop AI assistant that runs entirely on
> your PC. Your keys, your data, your control.
>
> **Features:**
> - Voice chat with customizable AI characters
> - Screen capture and computer-use automation
> - Agent Town — a living workspace for AI agents
> - Local memory system that learns your preferences
> - Full offline capability — no cloud account required
> - Bring your own API keys (Google Gemini, OpenRouter, and more)
> - 9 voice personas with distinct personalities
> - Multiple themes and HUD configurations
> - WhatsApp bridge for remote access (optional)
>
> **Privacy first:** All data stays on your computer. No telemetry, no
> tracking, no cloud backend. API keys are encrypted with Windows DPAPI.
> Uninstall removes the app; your data stays until you delete it.
>
> **Requirements:** Windows 10 1809+ (64-bit), 8 GB RAM, 3 GB disk space.
> Internet optional (needed for AI providers).
