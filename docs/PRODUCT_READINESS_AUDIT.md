# KnockDesk Product-Readiness Audit

## Executive status

KnockDesk has a maintained source-owned Electron/React desktop shell and a separate packaged Windows application. The source-owned shell can compile and stage independently, but the repository is **not yet verified as a complete, feature-parity, release-ready product**. A successful UI build is not proof that every bundled service, provider, native dependency, or legacy packaged screen works end to end.

## Verification matrix

| Area | Automated coverage | Remaining gap |
|---|---|---|
| Electron source | TypeScript compile, output assertions, source wiring tests | Signed installer and feature parity with compiled legacy main process |
| Desktop React renderer | Type-check, unit tests, ESLint and production bundle | Every route against a live Hermes installation |
| Windows smoke test | Launches Electron and exercises source-owned renderer with smoke mode | Hermes and AgentTown sidecars intentionally disabled in smoke mode |
| Packaged archive | ASAR listing, brand invariant, real LFS payload checks | Every packaged UI screen and integration is not exhaustively tested |
| Git LFS | Pointer and binary-attribute checks | LFS availability on another machine/account |
| Python and secrets | Python syntax, Ruff and first-party secret scan | Secrets hidden in binaries, Git history or unscanned generated/upstream bundles |
| Privacy | Scanner and regression tests cover email addresses plus Windows/Unix home paths in selected first-party text files | Binary metadata, historical commit metadata, upstream source and generated/vendor payloads require separate review |
| Dependencies and licenses | Blocking npm/Python audits, validated patched desktop dependency set, and bundled notices | License compatibility of all transitive dependencies and binary provenance |

## Feature status

| Feature | Source or packaged component | Verification status |
|---|---|---|
| Desktop shell/navigation | React source and Electron main process | Automated build and renderer smoke path; real Windows interaction still needed |
| Hermes runtime | Runtime controller plus optional CLI/virtual environment | Requires clean-machine test with the intended runtime |
| Memory read/update | Local file reader and Hermes prompt path | IPC payload contract tested; real update needs an active Hermes CLI |
| AgentTown | Standalone Next.js output and controller | Bundle presence checked; real startup/readiness/UI integration needs testing |
| Legacy packaged dashboard | resources/app.asar and resources/main.jsc | Archive can be inspected; feature-by-feature runtime test is incomplete |
| Voice, computer use, messaging and provider integrations | Plugins, source and native/data payloads | Each needs separate permission, credentials and runtime tests |
| Install, update and uninstall | Existing package plus validation scripts | Clean install/upgrade/uninstall and user-data retention remain release gates |

## Source versus packed artifacts

- Maintained desktop source: resources/hermes-runtime/src/electron/ and resources/hermes-runtime/src/web/src/desktop/.
- Separate Hermes dashboard source: resources/hermes-runtime/src/web/src/.
- Packaged app: resources/app.asar, resources/main.jsc and KnockDesk.exe.
- AgentTown is stored as standalone Next.js build output, not its original TypeScript project.
- V8 bytecode, native modules, browser engines, trained data and other binary payloads cannot be turned into original source by unpacking.
- The manual [Unpack KnockDesk ASAR workflow](https://github.com/OpKnock/KnockDesk/actions/workflows/unpack-asar.yml) downloads the actual LFS archive only when explicitly triggered and uploads extracted files for seven days. It does not commit generated vendor files or replace the original archive.

## Personal-data review

The privacy scanner checks both slash styles for Windows user paths and has regression coverage for that case. The bulk unpack helper derives the repository root from its own file location rather than a machine-specific absolute path. Scans still cover selected first-party text files only; this is not a guarantee about binaries, embedded metadata, upstream code or generated/vendor payloads.

The reachable `main` history has been rewritten to use the `OpKnock` account identity and its GitHub no-reply address. Historical commit objects and merged pull-request references that are no longer reachable from `main` can still remain resolvable on GitHub or in existing clones; removing those external references is a separate GitHub/account-support task. Upstream legal attribution and third-party author credits must remain intact.

## Release checklist

- [x] Latest GitHub Actions run is green, including blocking dependency audits, source build/tests, first-party security tooling, Git LFS integrity, packaged artifact integrity, and the Windows renderer smoke test.
- [ ] Configure protection for `main` with required CI checks, no force-pushes, and no branch deletion where the repository plan supports it. An unprotected branch is a governance gap, not itself a GitHub Terms of Service violation.
- [ ] Start the app on a clean Windows machine using the intended Hermes CLI/virtual environment.
- [ ] Verify runtime status, chat/session pages, memory read/update and shutdown/restart behavior.
- [ ] Start AgentTown, validate the served Next.js page and confirm closing KnockDesk stops only app-owned child processes.
- [ ] Configure and test each advertised model provider, messaging channel, voice and computer-use feature.
- [ ] Compare the source-owned UI with required features from the legacy packaged UI and document intentional omissions.
- [ ] Inspect and test an extracted ASAR before replacing anything in an installed app; preserve a rollback copy.
- [ ] Reconcile bundled versions, generate a release SBOM, and review GSAP licensing, FFmpeg build licensing, helper provenance and required notices.
- [ ] Test clean install, upgrade, uninstall and user-data retention.
- [ ] Review source, binary metadata, Git commit identity and external integrations before changing repository visibility.
- [x] Keep example credentials in `.env.example` unmistakably fake and run the secret scanner against it.

## Automated security baseline

The maintained desktop dependency set now passes a blocking npm audit at all severities, and the computer-use Python requirements pass a blocking `pip-audit`. Electron was upgraded to the patched 44.x line, and KnockDesk explicitly installs Electron's platform binary on demand for fresh development and Windows CI environments. These checks prevent known dependency advisories from being silently treated as warnings, but they do not replace runtime security review or third-party license/provenance work.

## Current limitations

The source build produces a staging application, not a signed installer. The Windows CI smoke mode intentionally skips live sidecars. The original ASAR and compiled main bytecode are preserved, and parity with the packaged application is not claimed. Until the release checklist is complete, classify KnockDesk as **in active stabilization**, not fully product-ready.
