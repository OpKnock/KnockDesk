# KnockDesk

KnockDesk is a local-first Windows desktop workspace for the Hermes AI agent runtime. It combines a maintained Electron/React desktop shell with a separately preserved packaged application and local runtime integrations.

> **Project status:** active stabilization. The source-owned shell has automated build and smoke-test coverage, but complete feature parity, live integrations, installer behavior, and the original packaged application's end-to-end behavior are not yet certified as a production release.

## What is included

- **Maintained desktop shell:** Electron main process, a narrow preload/IPC bridge, and the React interface under `resources/hermes-runtime/src/`.
- **Hermes runtime and dashboard:** Python runtime code, web dashboard source, configuration, and local integration points.
- **Optional capabilities:** AgentTown, memory utilities, plugins, computer-use helpers, and voice/browser assets. Some features require local runtime setup, credentials, OS permissions, or external providers.
- **Existing packaged app:** `KnockDesk.exe`, `resources/app.asar`, and `resources/main.jsc`, preserved separately from the source build.
- **Maintenance tooling:** source/build tests, privacy and secret scans, archive extraction, runtime smoke tests, and file inventory generation.

The source-owned desktop shell is independently maintainable; it is not yet a feature-for-feature replacement for every screen in the older packaged build.

## Requirements

For the source-owned desktop shell:

- Windows 10 or Windows 11.
- Node.js 22 or later and npm.
- Git and Git LFS to retrieve packaged binary payloads.
- A configured Hermes runtime/CLI for agent features. Renderer smoke tests can run without starting live sidecars.

Python 3.11 is used by the repository's maintenance checks and Windows smoke test.

## Get the code

```powershell
git lfs install
git clone https://github.com/OpKnock/KnockDesk.git
cd KnockDesk
git lfs pull
```

The repository is private unless its owner changes visibility. Git LFS pointers are small metadata files, not usable executables or archives; `git lfs pull` retrieves the actual payloads for files tracked with LFS.

## Run the desktop shell

From the repository root:

```powershell
npm run dev
```

The launcher installs the locked Electron and web workspaces, compiles the Electron main process, starts the desktop Vite renderer, and launches Electron. Close the window or press Ctrl+C to stop it.

The renderer can open without a working Hermes runtime. To use the assistant and other runtime-backed features, configure the Hermes CLI/virtual environment. When the bundled runtime is unavailable, set `KNOCKDESK_HERMES_EXE` to the full path of the Hermes executable.

## Build and validate

```powershell
npm test
npm run check:knockdesk
npm run check:privacy
npm run check:secrets
npm run test:maintenance
```

The source workspace checks can also be run directly:

```powershell
cd resources/hermes-runtime/src
npm ci --workspace electron --workspace web --include-workspace-root=false --no-audit
npm run compile --workspace electron
npm run typecheck --workspace web
npm test --workspace web
npm run build:desktop --workspace web
```

GitHub Actions additionally checks Python syntax and tooling, dependency manifests, Git LFS pointers, packaged-archive integrity, the renderer build, and a Windows Electron smoke test. These automated checks do not prove that every provider, channel, voice device, native module, or optional sidecar works on every Windows machine.

## Inspect and unpack bundled files

### Inspect the legacy Electron archive

Run `git lfs pull` first, then from the repository root:

```powershell
npm run list:asar
npm run unpack:asar
```

The extraction is written to `resources/app.asar.extracted/`. To rebuild an inspection copy without overwriting the original archive:

```powershell
npm run repack:asar
```

The rebuilt archive is written to `resources/app.rebuilt.asar`. The helper refuses to overwrite the original `resources/app.asar`. Extracted output is ignored by Git so generated files do not accidentally bloat commits.

### Inspect ZIP, wheel, and Chromium PAK resources

```powershell
npm run unpack:all
```

This command processes repository `.zip`, `.whl`, and `.pak` files and writes sibling `.extracted` directories. It skips generated extraction directories on later runs and rejects unsafe ZIP member paths. Bundled runtimes contain many files, so this broad inspection command can consume substantial disk space. Prefer `npm run unpack:asar` when you only need the main Electron archive.

You can also use the [Unpack KnockDesk ASAR workflow](https://github.com/OpKnock/KnockDesk/actions/workflows/unpack-asar.yml) to download an inspection artifact. Generated extracted files are not committed automatically.

**Important:** extraction provides access to archive contents; it does not reconstruct missing original TypeScript/React source, source maps, or V8 bytecode. AgentTown is present as a standalone Next.js build output, and `resources/main.jsc` is compiled bytecode. For durable UI changes, use the maintained source under `resources/hermes-runtime/src/web/src/desktop/`.

## Repository map

| Path | Purpose |
|---|---|
| `resources/hermes-runtime/src/electron/` | Electron main process, preload bridges, and runtime controllers |
| `resources/hermes-runtime/src/web/src/desktop/` | Maintained KnockDesk React desktop interface |
| `resources/hermes-runtime/src/web/src/` | Hermes management dashboard source |
| `resources/hermes-runtime/src/hermes_cli/` | Hermes CLI and Python runtime source |
| `resources/hermes-plugins/` | Hermes and KnockDesk plugins |
| `resources/knockdesk-computer/` | Computer-use sidecar source |
| `resources/agent-town-dist/` | Built AgentTown standalone application |
| `resources/app.asar` | Packaged Electron application archive |
| `resources/main.jsc` | Compiled V8 bytecode; not editable source |
| `resources/browsers/` | Browser and media runtime payloads |
| `scripts/` | Build, test, privacy, inventory, and unpacking utilities |
| `docs/BUILD_AND_SOURCE_MAP.md` | Source-versus-binary map and build guidance |
| `docs/PRODUCT_READINESS_AUDIT.md` | Verification coverage and remaining release gates |

## Privacy and security

KnockDesk is **local-first, not universally offline**. Settings, memory files, and runtime data are stored locally by default. Data may leave the machine when you configure cloud model providers, messaging integrations, remote relays, or external services. Review provider terms, credentials, and permissions before enabling those features.

The Electron renderer uses context isolation and a narrow preload bridge. Keep runtime command approval enabled unless you deliberately configure an alternative. Never commit API keys, access tokens, private logs, or machine-specific file paths.

Run the repository checks with `npm run check:privacy` and `npm run check:secrets`. They scan selected first-party text files and cannot prove that binaries, generated artifacts, historical commits, or upstream components contain no personal information.

## License and third-party components

KnockDesk first-party code is licensed under the Apache License 2.0; see [LICENSE](LICENSE). Third-party code and assets retain their own licenses and notices. Review [NOTICE.md](NOTICE.md), the included license texts, and the release-specific dependency inventory before redistributing binaries.

## Release readiness

Before describing a build as production-ready, complete the release checklist in [docs/PRODUCT_READINESS_AUDIT.md](docs/PRODUCT_READINESS_AUDIT.md). In particular, validate live Hermes/AgentTown startup and shutdown, exercise enabled integrations on a clean Windows machine, compare the source shell with packaged features, test installation and user-data retention, and resolve the third-party licensing/provenance review items.
