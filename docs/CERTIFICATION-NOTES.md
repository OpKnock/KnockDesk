# Certification notes for Partner Center — KnockDesk 3.1.12

Paste into the "Notes for certification" field (they are shown to the
certification tester). No account or login is required to use the app, so no
test account is needed.

## What the app is

KnockDesk is an offline-installable Windows desktop assistant (Electron app
plus a bundled Python runtime and a local browser for in-app pages). It talks
to AI providers only when the user supplies their own API key. There is no
account system, no server-side login, and no paid feature inside the app.

## Things you may notice while testing

- **The window goes quiet when left alone.** Two minutes without input, the
  ambient motion (a breathing orb, panel glows) parks to save battery. Any
  mouse move, key press, or new reply brings it straight back. This is
  deliberate idle behaviour, not a frozen app.
- **A SmartScreen warning on first run** until the binaries are countersigned.
- **A local update feed** is disabled by default in this build; the updater
  logs a harmless error line about it every few minutes. Nothing is being
  contacted.

## Steps to test the app

1. Install the submitted installer. A standard per-user install works without
   elevation; `/S` performs a silent install.
2. Launch KnockDesk from the Start menu. The window opens directly, no
   terminal, IDE, or local server is involved.
3. The app is usable without any API key: chat, settings, and all navigation
   work. AI replies need a provider key, which the tester adds in
   Settings, then AI Engine. Any Google Gemini or OpenRouter key works; a free
   Gemini API key from Google AI Studio is enough.
4. To test voice: enable the microphone toggle in Settings, then start a
   voice session. Speech is transcribed through the chosen provider and the
   reply is spoken back.
5. To test computer control: enable it in Settings, then approve the consent
   prompt. Control only starts after that approval and stops when the user
   turns it off. This step is optional for the core app.

## If something cannot be tested

Everything advertised on the Store listing runs locally on the submitted
binary. The only features that need external configuration are the AI calls
that require the user's own provider key, which is expected for a
bring-your-own-key app and is disclosed on the privacy page.

## Expected security prompts

Until the binaries are countersigned, Windows SmartScreen shows an
"unrecognized app" warning on first run; choose More info, then Run anyway.
The SHA-256 of the installer is published on the product site and in the
release notes for verification.

## Network behavior the tester will see

- All app services bind to 127.0.0.1 only (renderer, API, bridge, agent
  office). Nothing listens on the LAN.
- Outbound network calls happen only after the user adds a provider key, and
  only toward that provider's API endpoint.
- No telemetry, analytics, or crash-upload service is contacted.

## Uninstall

Settings, Apps, KnockDesk, Uninstall removes the application, its Start-menu
shortcuts, and its registry entries. User data under Documents and
%APPDATA%\KnockDesk is preserved by design and is documented as removable by
the user.
