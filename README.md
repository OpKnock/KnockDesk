# KnockDesk

**KnockDesk** is a local-first Windows desktop workspace for the Hermes AI agent runtime. The repository contains the Windows distribution, maintained Electron/React source for a separately buildable desktop shell, local runtime controllers, plugins, and validation tooling.

## Project status

This repository contains two related but distinct desktop experiences:

- **Packaged distribution:** KnockDesk.exe, resources/app.asar, and resources/main.jsc. These files form the currently shipped application. The compiled renderer and V8 bytecode are not the original TypeScript/React source.
- **Source-owned desktop shell:** resources/hermes-runtime/src/electron/main.ts and resources/hermes-runtime/src/web/src/desktop/. This shell has its own build, test and Windows smoke-test path. It is maintainable source, but it is **not yet a feature-for-feature replacement** for every screen and behavior in the packaged UI.

The source build produces a staging directory, not a signed installer or a release that replaces the existing binaries. CI results and known limitations are documented in [Build and source map](docs/BUILD_AND_SOURCE_MAP.md) and the [Product-readiness audit](docs/PRODUCT_READINESS_AUDIT.md).

## Capabilities

The source-owned shell includes desktop navigation/layout, runtime status and start controls, an embedded Hermes dashboard view, local memory inspection and memory requests, system diagnostics, and the optional AgentTown visualizer. Its integrations are intentionally exposed through a narrow Electron preload bridge rather than unrestricted renderer access to Node.js.

The packaged distribution includes additional components such as the Hermes runtime, browser and computer-use support, messaging integrations, voice support, and other bundled applications. Availability depends on the selected runtime, configured providers, permissions, and external services.

## Requirements

For a source build:

- Windows 10 or 11 for the desktop application and Windows smoke test.
- Node.js 22 or later and npm.
- Git with Git LFS installed to retrieve large packaged binaries.
- A working Hermes CLI/runtime for agent features. The renderer can be smoke-tested without starting the agent runtime.

## Get the repository

~~~powershell
git lfs install
git clone https://github.com/OpKnock/KnockDesk.git
cd KnockDesk
git lfs pull
~~~

The repository is private unless its owner changes its visibility. Git LFS pointers are not executable files; run git lfs pull to fetch their payloads.

## Run the source-owned desktop shell

From the repository root:

~~~powershell
npm run dev
~~~

The development command installs the locked Electron and web workspaces, compiles the Electron main process, starts the desktop Vite renderer, and launches Electron. Close the desktop window or press Ctrl+C to stop it.

The development shell looks for a Hermes installation/runtime. If a bundled virtual environment is not present in your checkout, install/configure Hermes separately or set STONIC_HERMES_EXE to the full path of the Hermes executable. AgentTown is optional and starts when selected.

## Build and test

From the repository root:

~~~powershell
npm test
npm run check:knockdesk
~~~

The source-owned renderer can also be checked from the Hermes workspace:

~~~powershell
cd resources/hermes-runtime/src
npm ci --workspace electron --workspace web --include-workspace-root=false --no-audit
npm run compile --workspace electron
npm run typecheck --workspace web
npm test --workspace web
npm run build:desktop --workspace web
~~~

The root npm test runs source/build-contract regression tests. GitHub Actions adds workspace installation, TypeScript checks, dashboard tests, renderer lint/build, Python syntax/security-tool checks, LFS integrity checks, dependency audits, and a Windows Electron renderer smoke test. A passing renderer smoke test does **not** prove that every optional provider, messaging platform, voice feature, or the original packaged UI works end to end.

## Inspect or unpack the packaged application

Download the actual LFS payloads first. Then use the repository's archive helper:

~~~powershell
npm run list:asar
npm run unpack:asar
~~~

The default extraction goes to resources/app.asar.extracted/, which is ignored by Git so generated unpacked files do not accidentally bloat commits. To rebuild an inspection copy without overwriting the original archive:

~~~powershell
npm run repack:asar
~~~

The rebuilt archive is written to resources/app.rebuilt.asar. The original resources/app.asar is never overwritten by the helper. You can also run the manual [Unpack KnockDesk ASAR workflow](https://github.com/OpKnock/KnockDesk/actions/workflows/unpack-asar.yml) to produce a downloadable extraction artifact for seven days; this is generated output, not recovered original source. See [Build and source map](docs/BUILD_AND_SOURCE_MAP.md) for boundaries between source, generated output, bytecode, binary payloads and external services.

Unpacking an ASAR makes the bundled files inspectable; it does not recover TypeScript, React source maps, or the source for V8 bytecode. For durable dashboard changes, prefer the maintained source under resources/hermes-runtime/src/web/src/desktop/.

## Data, privacy and network behavior

KnockDesk is **local-first, not universally offline**. Application settings, memory files, and runtime data are stored locally by default. However, data leaves the machine when you choose cloud model providers, connect messaging platforms, use remote relays or integrations, or open external services. Provider/API terms then apply. WorldMonitor and other external views are not controlled by this repository.

Microphone, computer-use, browser-control, messaging, and remote-access features may require OS permissions, credentials, or explicit configuration. Review each integration before enabling it. Never commit API keys, personal access tokens, session tokens, private logs, or local machine paths.

A source scan is available for accidental email addresses and machine-specific home-directory paths in first-party project files:

~~~powershell
python scripts/privacy-scan.py
~~~

This scan does not remove identity from Git commit history or from the GitHub account/profile. It also cannot prove that every binary or generated payload is free of personal metadata.

## Repository map

| Path | Purpose |
|---|---|
| resources/hermes-runtime/src/electron/ | Electron main process, preload bridges and runtime controllers |
| resources/hermes-runtime/src/web/src/desktop/ | Maintained React desktop renderer |
| resources/hermes-runtime/src/web/ | Hermes web dashboard source and Vite configs |
| resources/hermes-runtime/src/hermes_cli/ | Hermes CLI and Python dashboard/runtime source |
| resources/hermes-plugins/ | KnockDesk plugins |
| resources/knockdesk-computer/ | Computer-use sidecar source |
| resources/agent-town-dist/ | Built AgentTown standalone application; not its original source project |
| resources/app.asar | Packaged Electron application archive |
| resources/app.asar.unpacked/ | Native modules and files unpacked by Electron packaging |
| resources/main.jsc | Compiled V8 bytecode; not editable TypeScript source |
| resources/hermes-runtime/python/ | Embedded Python runtime and installed packages |
| resources/browsers/ | Browser/FFmpeg payloads |
| scripts/ | Build, unpack, validation and maintenance tooling |
| docs/INVENTORY.md | How to generate/download the file-by-file inventory |
| .github/workflows/ | CI and inventory workflows |

See [Build and source map](docs/BUILD_AND_SOURCE_MAP.md) for the authoritative source-vs-binary distinctions.

## Security and release notes

- Keep Electron context isolation enabled and Node integration disabled in renderer pages.
- Treat external URLs, provider responses, IPC payloads, and generated files as untrusted input.
- The packaged executable and archive are preserved by the source build; use a separate release process to replace them.
- Review [NOTICE.md](NOTICE.md) before redistribution. The repository's third-party licensing inventory includes items that still require release-time verification.

## License

KnockDesk first-party code is licensed under the Apache License 2.0; see [LICENSE](LICENSE). Third-party components retain their respective terms. See [NOTICE.md](NOTICE.md) and the license texts shipped with the distribution.
