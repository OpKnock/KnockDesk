# KnockDesk Privacy Policy (shipped with the app; also publish at the support URL before Store submission)

Effective: 2026-10-17. Contact: see README support channel.

## What runs where
KnockDesk is a local-first desktop assistant. The UI, Hermes dashboard,
AgentTown sidecar, and bridges run **on your PC** (`http://127.0.0.1` only).
No account, no cloud backend operated by OpKnock.

## Data stored on your PC
- Settings, profiles, themes, voice choice: `%APPDATA%\knockdesk` (+ JSON stores beside it). Older installs are migrated there from `%APPDATA%\stonic_gen3` on first launch.
- API keys you paste (Google Gemini, OpenRouter, etc.): OS-protected local
  stores (DPAPI on Windows). Keys are never written to logs.
- Chat history, memories, notes, tasks: local JSON/SQLite under the same root.
- Screenshots/avatars you capture: your Downloads folder, your files.
- Uninstall preserves `%APPDATA%\knockdesk`. Delete that folder to erase everything.

## Microphone, camera, screen
Used only when you explicitly start a feature that needs it (voice chat,
screen capture, computer-use automation). Audio/video is processed locally
or sent to the AI provider you configured, per that provider's policy.
KnockDesk performs no background recording.

## Network transmission
- To AI providers (Google, OpenRouter, etc.) only: your prompts and the
  context needed to answer, using the keys you supplied.
- Local loopback between the app and its sidecars.
- Update checks (when enabled): version query to the configured feed.
- No advertising, no cross-site tracking, no sale of data.

## Retention and deletion
Data stays on your PC until you delete it. In-app clearing (where offered)
deletes the corresponding local stores. Full removal: uninstall the app,
then delete `%APPDATA%\knockdesk` (and, if it still exists, the legacy `%APPDATA%\stonic_gen3` folder).

## Generative-AI disclosure
Responses are machine-generated and can be wrong. The app labels AI content
in chat; verify important facts independently. Report abusive or unsafe
outputs through the support channel so provider/model settings can be
adjusted; provider-level abuse reporting follows each provider's own process.
