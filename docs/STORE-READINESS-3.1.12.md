# Microsoft Store submission readiness — KnockDesk 3.1.12

Date: 2026-10-19. Release under test: v3.1.12 (installer SHA-256
`6792E8F79435426E7474C80FFE6CA10A2DCDCED6C53164579993AA1AF45CAF48`,
macOS bundles unchanged from the same release).

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
| Idle behaviour | PASS (with note) | The 60-second observation window showed steady resource use. Longer idle soaks are part of the friend's test pass (plan: `docs/MACOS_TEST_PLAN.md`; the Windows soak is the same procedure) |
| No developer-only dependencies | PASS | The installer ships the bundled Python runtime, Hermes venv, and browser payload; first launch needs no terminal |

### Packaging (evidenced)
| Check | Status | Evidence |
|---|---|---|
| HTTPS, versioned installer URL | PASS | Release asset URLs are HTTPS under the v3.1.12 tag |
| Standalone installer, not a downloader | PASS | 779 MB NSIS installer contains the full payload |
| Silent install | PASS | `/S` silent path exercised end to end |
| Accurate publisher/version metadata | PASS | ProductName KnockDesk, CompanyName OpKnock, FileVersion 3.1.12 |
| Upgrade/reinstall/uninstall | PASS | Upgrade over the same directory verified; uninstall removes files, registry keys, and shortcuts |
| Valid Authenticode signature chaining to a trusted root | **BLOCKED** | Both files report `NotSigned`. Requires a certificate — see Signing below |

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

### Listing metadata (evidenced)
| Check | Status | Evidence |
|---|---|---|
| Name/publisher unique and accurate | PASS | KnockDesk / OpKnock, no affiliated brands named |
| Description matches features | PASS | The site download and guide pages mirror the shipped feature set, including the macOS caveats |
| System requirements accurate | PASS | Windows 10 1809+ 64-bit / macOS 11+ |
| Age rating questionnaire | READY | The app has no UGC publishing, gambling, or violence surfaces |

## Known deltas in the published v3.1.12 artifact

The published installer (SHA-256 `6792E8F7…`, built Oct 19 02:13) is current
through PR #39. Two later merges are not in it and are not user-visible in the
app UI, but they are in the repository and scheduled for the next build:
- **PR #45** renames the computer sidecar's logical model names to the
  KnockDesk names the gateway mapping now expects (old names still resolve
  through env overrides, so this is a rename, not a behavior change).
- **PR #46** rebrands `resources/dist/audio/README.txt`, the one user-browsable
  file inside the asar that still carried the old brand.

Interim state: installing from the current published release gives the fully
rebranded UI, all tool fixes, and the gateway key injection. The two deltas
ship with the next installer.

## Follow-ups before submission

1. **Unsigned binaries** (installer + exe): SmartScreen will warn and the
   Store path may reject at package validation. Owner action: SignPath
   Foundation free OSS approval (wired in CI — the release will be signed the
   moment the approval and secrets land), Azure Trusted Signing (~$10/month),
   or a purchased OV certificate. See `docs/ops/signing.md`.
2. **Friend's real-hardware pass**: the macOS bundles and the longer idle soak
   need the friend's hardware (plan: `docs/MACOS_TEST_PLAN.md`).
3. **Extract API key is optional**: web page extraction is search-only until
   an extract provider key is added (Firecrawl/Tavily/Exa/Parallel). Search
   works without one.

## Tools and reproduction
- Mend-AI GOA quick scan of the repository: `runs/C-Users-wagde-MegaProjects-KnockDesk-20261019-035641-2dc7` (0 findings, heuristic mode).
- Mend-AI GOA deep scan of the site: `runs/https-knockdesk.app-20261019-035653-040d` (0 findings, heuristic mode).
- Live probes: nmap (`-sT -sV`) plus the HTTP control probes above, run against the app during this session.
- Install/uninstall: `scripts/uninstall_verify.py`, an install audit, and a manual three-cycle loop.
