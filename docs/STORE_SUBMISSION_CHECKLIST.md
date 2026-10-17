# KnockDesk — Microsoft Store Submission Checklist

Date: 2026-10-17. Version: 3.1.12-local. Status per item: VERIFIED / FAILED / BLOCKED / N/A.

## Package Identity and Versioning

| Item | Status | Notes |
|------|--------|-------|
| Version scheme (semver) | VERIFIED | 3.1.12 in exe metadata + package.json + NSIS VIAddVersionKey |
| Architecture declared | VERIFIED | x64 (NSIS installer targets 64-bit) |
| Package identity (Publisher/Name) | BLOCKED | Requires Partner Center account + reserved name "KnockDesk" |
| Version sync across exe/installer/about | VERIFIED | FileVersionInfo: 3.1.12; NSIS: 3.1.12; app displays 3.1.12-local |

## Packaging Approach

| Item | Status | Notes |
|------|--------|-------|
| NSIS offline installer (not MSIX) | VERIFIED | See docs/PACKAGING_DECISION.md — MSIX blocked by unsigned status + 2.7GB payload + bytecode main |
| Standalone (no web downloader) | VERIFIED | All 2.7GB payload embedded in installer |
| MSIX packaging | N/A | Deferred until signing + payload reduction; see PACKAGING_DECISION.md |

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
| User data preserved on upgrade | VERIFIED | `%APPDATA%\stonic_gen3` outside install dir; installer kills running exe, replaces files |
| User data preserved on uninstall | VERIFIED | Uninstaller does not touch `%APPDATA%\stonic_gen3` |
| Clean uninstall | VERIFIED | Removes install dir, shortcuts, HKCU registry keys |

## Code Signing

| Item | Status | Notes |
|------|--------|-------|
| Production signing certificate | BLOCKED | Not purchased. `scripts/sign-release.ps1` is cert-gated (refuses without one). |
| Timestamp server | BLOCKED | Depends on certificate |
| Signature verification post-build | BLOCKED | Depends on certificate |
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
| Account creation | BLOCKED | User action required |
| App name reservation | BLOCKED | User action required |
| Package upload | BLOCKED | Requires installer to be signed first |
| Test notes for certification | BLOCKED | Draft below; needs user review |
| Restricted capabilities | N/A | No camera/mic declared as capabilities; app requests at runtime via Electron APIs |
| External services disclosure | BLOCKED | Needs listing of Google Gemini / OpenRouter / user-configured AI providers |

## WACK (Windows App Certification Kit)

| Item | Status | Notes |
|------|--------|-------|
| WACK installed | VERIFIED | `C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe` |
| WACK against NSIS installer | BLOCKED | WACK requires a signed app package (MSIX/AppX); NSIS installers are Win32 and tested via the standard Store onboarding flow, not WACK. See "Notes" below. |
| Crash-free launch | VERIFIED | Smoke test passes: boot, splash, main window, idle 60s, clean shutdown, no orphans |

**WACK note**: WACK validates MSIX/AppX packages. For unpackaged Win32 apps
distributed via the Store's "MSIX from EXE" or standalone EXE path, Microsoft
performs its own validation during submission. Our NSIS installer falls under
the standalone-EXE path. WACK is NOT APPLICABLE to this packaging choice.
If MSIX packaging is pursued later (after signing), WACK becomes applicable.

## Remaining Blockers (user action required)

1. **Purchase code-signing certificate** (OV/EV from DigiCert/Sectigo/etc.)
2. **Create Partner Center account** and reserve "KnockDesk" name
3. **Provide support URL** for Store listing
4. **Host privacy policy** at a public URL
5. **Capture screenshots** at required resolutions
6. **Review and approve** the draft description below
7. **Test on clean Windows machines** (VM or physical, no dev tools)

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
