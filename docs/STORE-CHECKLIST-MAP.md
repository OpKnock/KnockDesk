# Microsoft Store rejection checklist — where each item stands

Maps the full rejection checklist (A-L) to the evidence in
`STORE-READINESS-3.1.12.md` and to what still needs the submission owner.
Status values: PASS (verified here), OWNER (needs you or a human with the
account), N/A (does not apply to this product).

## A. Crashes, hangs, fails to launch

| Item | Status | Note |
|---|---|---|
| Installer completes on a clean Windows machine | PASS | Silent install into a fresh per-user dir: exit clean, 48,448 files |
| Launches from the Start menu | PASS | Single entry, points at the install dir (stale dev shortcut removed) |
| First launch without dev terminal/IDE/server | PASS | Bundled Python, Hermes venv, and browser payload all ship |
| Responsive during startup and AI load | PASS | Live run: window opens, sidecars serve |
| No blank window, freeze, endless spinner | PASS | Window paints; idle soak measured at 0-3% of one core |
| Works after restart and fresh sign-in | OWNER | Needs a reboot and a fresh sign-in on a real machine |
| Handles missing config, outages, provider errors | PASS | Boots with no key and reports it; bad key handled; sidecar fails fast with the provider's own reason |
| Handles expired sessions and failed auth | PASS | Voice session logs the reason and offers restart; no silent "done" |
| Closes cleanly and reopens | PASS | Task-tree close leaves zero orphans; reopen verified |
| No excessive CPU/RAM/GPU/battery while idle | PASS | Idle fix verified over 15 minutes: ~0-3% of one core after two idle minutes |
| No startup deadlock or endless retry | PASS | Three boot cycles observed |
| Unsupported hardware gets a clear explanation | OWNER | No exotic hardware available here; the no-key path already shows the pattern |

The reported "hangs badly when left idle" was investigated and is **not** a
hang. See the idle-CPU section of the readiness report for the measurement
trail and the fix.

## B. Installer and packaging

| Item | Status | Note |
|---|---|---|
| HTTPS, versioned installer URL | PASS | Release assets under the v3.1.12 tag |
| Binary not silently replaced after submission | PASS | Immutable release tag + published SHA-256 |
| Standalone installer, not a downloader | PASS | 780 MB, payload included |
| Silent install with correct parameters | PASS | `/S` exercised |
| Appropriate exit codes | PASS | Verified by resulting state, not just the code |
| No dependence on developer paths or caches | PASS | Clean per-user install verified |
| Runtimes and resources included | PASS | Bundled Python runtime, Node via Electron, browser payload |
| Accurate product/publisher/version | PASS | KnockDesk / OpKnock / 3.1.12 |
| Upgrade, reinstall, uninstall | PASS | Upgrade over the same dir and uninstall both verified |
| Valid signature chaining to a trusted root | OWNER | Both files report NotSigned. SignPath (free for OSS) is wired in CI; Azure Trusted Signing is ~$10/month |

MSIX-specific rows are N/A: this is an EXE/NSIS submission, which has its own
package requirements.

## C. Security, malware, suspicious behavior

| Item | Status | Note |
|---|---|---|
| No malware or bundled software | PASS | No third-party installers, no elevation paths |
| No unexplained credential collection | PASS | Keys stay local, DPAPI-protected, redacted from logs |
| No hardcoded secrets | PASS | CI gate: 0 hits across 235 first-party files |
| No exposed debug endpoints | PASS | CDP browser endpoint needs a per-boot token; discovery returns empty; 9222 is local only |
| Secure handling of tokens and local data | PASS | See above |
| No disabling Windows protections | PASS | No policy/registry/Defender tampering |
| No unsupported modification of Windows settings | PASS | None found in the payload |
| No hidden persistence | PASS | Startup is opt-in; registry footprint matches the app |
| No unnecessary elevation | PASS | Per-user install |
| No vulnerable/obsolete dependencies | PASS | pip-audit and npm audit gates green |
| No unexpected remote code execution | PASS | Only configured providers and the update feed |
| No surprise third-party installs | PASS | None |

AI-specific rows: computer control is consent-gated and reviewable, the
microphone toggle is explicit, provider data flows are disclosed on the
privacy page, and no downloaded script changes the app's function.

## D. Privacy, accounts, data

| Item | Status | Note |
|---|---|---|
| Privacy policy exists | PASS | Ships with the app and on the site |
| Policy matches behavior | PASS | Compared the docs against the on-disk layout after a live run |
| No excess collection | PASS | BYOK app; prompts go only to the configured provider |
| Data flows disclosed | PASS | Stated in the policy and the site page |
| Sensitive data stored securely | PASS | DPAPI for keys; loopback-only bridge |
| Users can exercise promised controls | PASS | Keys and memories are user-readable and deletable |
| Microphone/file access disclosed | PASS | In-app permission surface plus README |
| Login required but testers locked out | N/A | No account system exists |
| Server unavailable during testing | N/A | No first-party server the app needs |
| Privacy-law compliance | PASS | Minimal collection, local-first |

## E. Complete functionality

| Item | Status | Note |
|---|---|---|
| Advertised features exist and work | PASS | Voice, search, memory, skills, computer control, AgentTown each exercised |
| No placeholder pages | PASS | Every surface launched |
| Login/onboarding completable | N/A | No login |
| No silent AI failure | PASS | Fast-fail with the provider's reason |
| First run explains purpose | PASS | Onboarding copy and empty states |
| Works only on the dev PC | PASS | Clean-machine install verified |

## F. Listing metadata

| Item | Status | Note |
|---|---|---|
| Name unique and accurate | PASS | KnockDesk / OpKnock |
| Description matches features | PASS | Site download/guide mirror the shipped set |
| Screenshots show the real app | OWNER | Capture from the installed app at submission time |
| Publisher identity correct | PASS | OpKnock |
| Category and search terms | OWNER | Partner Center fields |
| System requirements accurate | PASS | Win 10 1809+ 64-bit |
| Privacy policy URL valid | OWNER | Publish the shipped policy at the support URL |
| Age rating questionnaire | READY | No UGC, gambling, or violence surfaces |
| Accessibility claims | OWNER | Claim only what is tested |
| Localization | N/A | English only, declared as such |
| Store assets correct | OWNER | Icon files exist; sizes per Partner Center |

## G. Capabilities and Windows integration

| Item | Status | Note |
|---|---|---|
| Declared capabilities match function | PASS | Microphone and network declared for what they do |
| No circumvention of capability checks | PASS | None found |
| No undocumented API misuse | PASS | None found |
| No system changes without consent | PASS | None |
| Accessibility API used appropriately | PASS | No accessibility abuse |
| Background tasks behave | PASS | Sidecars are visible in the UI and close with the app |
| No undisclosed driver/service dependency | PASS | None |
| Clean removal | PASS | Uninstall removes files, registry, shortcuts |

## H. AI-specific risks

| Item | Status | Note |
|---|---|---|
| Advertised AI works | PASS | Live runs against the configured providers |
| No secret data exfiltration | PASS | Loopback services, provider-only traffic |
| No dynamic code changing app function | PASS | No remote code execution path |
| Outputs not misleading | PASS | The app presents model output as model output |
| Disclosures present | PASS | Privacy page and in-app copy |
| Consequential actions under user control | PASS | Computer control is consent-gated |
| Provider terms permit integration | PASS | BYOK: the user's own account and key |
| Subscription/AI limits not misrepresented | N/A | No paid features |
| No policy-violating content | PASS | None |

## I. Copyright and trademarks

| Item | Status | Note |
|---|---|---|
| Icons/artwork/fonts properly licensed | PASS | NOTICE.md lists bundled components and their licenses |
| Name implies no false affiliation | PASS | No affiliated brands named |
| Screenshots not misleading | OWNER | Capture the real app |
| Bundled libraries license-compliant | PASS | NOTICE.md is maintained |
| No third-party material without basis | PASS | None found |
| Listing names not misleading | PASS | None |

## J. Financial and subscriptions

N/A: the app has no paid features, no subscriptions, and no in-app purchase.

## K. Content and age rating

| Item | Status | Note |
|---|---|---|
| Assets and content policy-compliant | PASS | None problematic |
| Age rating accurate | READY | Questionnaire answers match content |
| No prohibited content | PASS | None |
| UGC handled per requirements | N/A | No UGC publishing surface |
| Dynamic content from servers | PASS | Model output is the user's own request |
| Regional requirements | OWNER | Market selection in Partner Center |

## L. Partner Center submission mechanics

| Item | Status | Note |
|---|---|---|
| Account active/verified | OWNER | Your developer account |
| Required fields present | OWNER | Submission-time fields |
| Installer downloadable | PASS | HTTPS release asset, verified reachable |
| No invalid URLs | PASS | Verified |
| Correct app/package type | OWNER | Choose the MSI/EXE path, not MSIX |
| Installer parameters | PASS | Silent install verified |
| Declarations consistent | PASS | Mic/network only |
| Age rating and markets | OWNER | Submission-time |
| Store assets | OWNER | Icons exist; screenshots to capture |
| Certification notes | PASS | `docs/CERTIFICATION-NOTES.md` is written for this |
| Package matches version | PASS | Artifact hash published |
| Test account needed | N/A | No login |
