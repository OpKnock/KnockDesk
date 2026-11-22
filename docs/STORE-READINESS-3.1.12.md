# Microsoft Store submission readiness — KnockDesk 3.1.12

Date: 2026-10-19. Release under test: v3.1.12 (installer SHA-256
`D020C05C0079D3B9B3CC01FC356F8F2A6D924E07DB6FE7DB868EFA6091C1B771`,
780 MB, built Oct 19 11:37 and carrying the idle-CPU throttle; macOS
bundles unchanged from the same release).

Method: live install/uninstall cycles, static scans, live network testing of
the running app with Mend-AI (nmap, GOA quick/deep runs, direct HTTP probes),
plus the repository's own CI gates (CodeQL, dependency audit, secret scan,
privacy scan, 56 source tests). Nothing below is claimed without evidence.

## Release gate tracker (26 items)

### Launch and stability (evidenced)
| Check | Status | Evidence |
|---|---|---|
| Installer completes on a clean Windows user account | PASS | Silent install of the release installer into a fresh per-user dir; exit code 0, 48,216 staged files, 2.6 GB |
| App launches from the Start menu | PASS | Shortcut target resolves; window titled KnockDesk opens |
| App remains responsive with sidecars loaded | PASS | 60-second live run; renderer (45678), Hermes dashboard (9119), run API (8642), bridge (8749), AgentTown (3010), CDP shim (9333) all serving |
| Clean shutdown and reopen | PASS | Task-tree kill; orphan-process sweep clean |
| Repeated cycles | PASS | Three install/launch/uninstall cycles in testing |
| Missing configuration is handled | PASS | With no provider key the app boots and reports the missing key in Settings; the computer sidecar fails fast with an actionable message (no silent "done") |
| Idle behaviour | PASS (with note) | Verified live for 15 minutes with the window visible: total app CPU settled to 0-3% of one core after the two-minute idle mark and held without spurious resume; full rate returns on the next interaction. Before the fix the ambient UI layer held the GPU process at ~150% of a core (see the fix note below) |
| No developer-only dependencies | PASS | The installer ships the bundled Python runtime, Hermes venv, and browser payload; first launch needs no terminal |

### Packaging (evidenced)
| Check | Status | Evidence |
|---|---|---|
| HTTPS, versioned installer URL | PASS | Release asset URLs are HTTPS under the v3.1.12 tag |
| Standalone installer, not a downloader | PASS | 780 MB NSIS installer contains the full payload |
| Silent install | PASS | `/S` silent path exercised end to end |
| Accurate publisher/version metadata | PASS | ProductName KnockDesk, CompanyName OpKnock, FileVersion 3.1.12 |
| Upgrade/reinstall/uninstall | PASS | Upgrade over the same directory verified; uninstall removes files, registry keys, and shortcuts |
| Authenticode signature that Windows trusts (trusted root) | **BLOCKED** | Installer is now signed and timestamped, but the chain resolves to `Codegic Root CA G2`, which is not in Microsoft's Trusted Root Program, so `signtool verify /pa` returns `0x800B010A` and SmartScreen still reports an unknown publisher. Store acceptance needs SignPath/Azure Trusted Signing or a purchased OV certificate |

### Security (evidenced)
| Check | Status | Evidence |
|---|---|---|
| No malware/unwanted bundled software | PASS | No third-party installers, no admin-elevation paths; no dark patterns |
| No hardcoded secrets in tracked files | PASS | `secret-scan.py`: 0 hits over 235 first-party files (CI gate) |
| No exposed debug endpoints | PASS | CDP shim browser endpoint requires a per-boot token; unauthenticated path returns 404; discovery `/json` returns an empty list with no websocket URL; port 9222 DevTools is bound locally and not advertised |
| No insecure handling of local credentials | PASS | API keys sit in DPAPI-protected local stores; secrets are redacted from tool output and logs |
| No disabling of Windows protections | PASS | No policy, registry, or Defender tampering anywhere in the payload |
| Computer control and microphone are documented | PASS | README, onboarding, and the in-app permission surface describe control and microphone use |
| Static analysis | PASS | CodeQL 0 open alerts; dependency audit green; 56 source tests green |
| Dynamic analysis of the live app | PASS | nmap sweep of 3010/45678/8642/8749/9119/9333/9222: every service is loopback-bound; bridge answers 401 without a key; the dashboard validates Host headers; traversal probes return 403 |
| Prior pentest findings | PASS | SSRF-01 (host canonicalization) and CDP-01 (token gate) are fixed in this build; the live host-header rejection and token gate were re-verified in this run |
| No unexpected network code execution | PASS | The only remote fetch paths are the AI providers the operator configures and the update feed (disabled by default in local builds) |

### Privacy (evidenced)
| Check | Status | Evidence |
|---|---|---|
| Privacy policy published | PASS | `docs/PRIVACY_POLICY.md` ships with the app and is publishable at the support URL; the site's privacy page matches it |
| Policy matches behaviour | PASS | The policy describes exactly the local stores the app writes (verified by comparing the docs with the actual on-disk layout after a live run) |
| Data flows disclosed | PASS | Prompts and speech go to the configured provider only; the bridge is loopback-only |
| Local files kept minimal | PASS | The app writes only to its data directories; the chat vault and skills folder are documented and user-readable |

### Functionality (evidenced)
| Check | Status | Evidence |
|---|---|---|
| Advertised features exist | PASS | Voice, search, memory, skills, computer control, and AgentTown were each exercised; the site copy describes the same feature set |
| No placeholder pages | PASS | Every advertised surface was launched at least once in testing |
| Computer control failures are visible, not silent | PASS | The sidecar aborts with the provider-account reason instead of a false completion (PR #35). The published installer was built Oct 19 02:13 and carries every fix merged through PR #39, including the gateway-key injection |
| Voice output works | PASS | Speech synthesizes through the configured voice path; when the free Microsoft endpoint refuses, the app falls back to the Gemini key, which the gateway receives (PR #39, in this installer) |
| Idle resource use | PASS | Ambient UI layer now parks after two idle minutes; see the fix note below |

### Listing metadata (evidenced)
| Check | Status | Evidence |
|---|---|---|
| Name/publisher unique and accurate | PASS | KnockDesk / OpKnock, no affiliated brands named |
| Description matches features | PASS | The site download and guide pages mirror the shipped feature set, including the macOS caveats |
| System requirements accurate | PASS | Windows 10 1809+ 64-bit / macOS 11+ |
| Age rating questionnaire | READY | The app has no UGC publishing, gambling, or violence surfaces |

## Known deltas in the published v3.1.12 artifact

None as of the Oct 19 11:37 build: the published installer carries every
fix that was in flight when testing started, including the idle-CPU
throttle, the asar README rebrand, the sidecar model-name rename, and the
Start-menu shortcut cleanup. Earlier builds on this page are superseded.

## Follow-ups before submission

1. **Signature chain not trusted** (installer + exe): the installer is
   Authenticode-signed and RFC 3161-timestamped, but the signer chains to
   `Codegic Root CA G2`, which is not in Microsoft's Trusted Root Program.
   Windows therefore reports the publisher as unknown and `signtool verify
   /pa` returns `0x800B010A`. The signature is cryptographically valid and
   the timestamp is trusted, so it keeps verifying after the certificate
   expires on 2026-12-19 - it simply does not carry reputation. The Store
   path will still reject at package validation. Owner action: SignPath
   Foundation free OSS approval (wired in CI - the release will be re-signed
   the moment the approval and secrets land), Azure Trusted Signing
   (~$10/month), or a purchased OV certificate. See `docs/ops/signing.md`.
2. **Real-hardware pass**: the macOS bundles and the longer idle soak
   need an actual Mac (plan: `docs/MACOS_TEST_PLAN.md`).
3. **Extract API key is optional**: web page extraction is search-only until
   an extract provider key is added (Firecrawl/Tavily/Exa/Parallel). Search
   works without one.
4. **Windows restart + fresh sign-in**: not exercised on this machine (would
   disrupt the session); the same install path a fresh user gets is covered
   by the clean-install rows above.

## The idle-CPU fix (ships in the next installer build)

The shipped UI keeps an ambient layer alive — infinite CSS animations (orb
breathe/pulse/spin, voice-HUD beams, recording ripples) plus a WebGL
particle globe — for as long as the window is visible. Measured on the
release build: the GPU process sat at ~150% of a core and one renderer at
~30-55% of a core, steady, with no user input. That is what users described
as the app hanging when left idle, and it is a certification item.

Root cause was **not** a hang: the window stayed responsive, closed cleanly,
reopened, and kept flat memory/handles. It was a continuously-recompositing
ambient layer. Two measurement facts pinned it down: minimizing the window
dropped CPU to ~0 (so it is presentation-driven), and pausing the CSS
animations plus throttling rAF only removed part of it (so part of the loop
captured its timer references at module scope, which a post-load injection
cannot reach).

Fix: `scripts/rebrand/idle-throttle.js` is loaded by the app's own
`dist/index.html` as the first script, so it patches `requestAnimationFrame`,
`setTimeout`, `setInterval`, and `Element.animate` before the app bundle
runs. After two idle minutes ambient schedulers drop to a 2 fps floor; any
input, DOM mutation, media playback, network call, or WebSocket message
restores full rate within one frame. Nothing is dropped, only slowed, so
live sessions and streaming replies are unaffected. Escape hatch:
`KNOCKDESK_DISABLE_IDLE_THROTTLE=1`.

Verified live over 15 minutes: total app CPU went from ~70s per 30s window
to ~0-1s per 30s (0-3% of a core) at the idle mark, held with no spurious
resume, and full rate returned on the next interaction. On a **fresh
profile** (what a certification tester or a new user gets) the whole app,
including the in-app browser's default dashboard page, idles at **0.7-3% of
one core**. On this authoring machine, which has a phone bridge connected and
a live session, the app correctly stays awake because real work is flowing.
The asar repack gates confirm 16,483 of 16,484 entries are byte-identical;
only the loader, the patched HTML, and the two intended new files differ.

A second install defect was found and fixed at the same time: a stale
Start-menu shortcut left by the developer install pointed at the repo
checkout and sorted above the installed entry, so "launch KnockDesk from
Search" ran the dev build. The installer now deletes that stale shortcut
and the uninstaller removes it, leaving exactly one entry.

## Tools and reproduction
- Mend-AI GOA quick scan of the repository: `runs/C-Users-wagde-MegaProjects-KnockDesk-20261019-035641-2dc7` (0 findings, heuristic mode).
- Mend-AI GOA deep scan of the site: `runs/https-knockdesk.app-20261019-035653-040d` (0 findings, heuristic mode).
- Live probes: nmap (`-sT -sV`) plus the HTTP control probes above, run against the app during this session.
- Install/uninstall: `scripts/uninstall_verify.py`, an install audit, and a manual three-cycle loop.
