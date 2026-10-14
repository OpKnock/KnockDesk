# Build and Source Map

This document distinguishes editable source from generated output and opaque binary payloads. It is intended to keep source changes reproducible and stop a successful renderer build from being mistaken for a complete release build.

## Main application paths

| Component | Repository path | State |
|---|---|---|
| Maintained desktop Electron entry point | resources/hermes-runtime/src/electron/main.ts | TypeScript source |
| Maintained desktop preload bridge | resources/hermes-runtime/src/electron/desktop-preload.js | Editable JavaScript source |
| Maintained React desktop interface | resources/hermes-runtime/src/web/src/desktop/ | React/TypeScript and CSS source |
| Desktop renderer entry / build configuration | resources/hermes-runtime/src/web/desktop.html, vite.desktop.config.ts | Editable source/configuration |
| Separate Hermes management dashboard | resources/hermes-runtime/src/web/src/, vite.config.ts | React source; built to hermes_cli/web_dist/ |
| Electron staging builder | build-electron-main.mjs | Editable build script |
| Hermes Python code | resources/hermes-runtime/src/hermes_cli/ and related source directories | Python source |
| KnockDesk plugins / computer-use sidecar | resources/hermes-plugins/, resources/knockdesk-computer/ | Source, subject to each component's license |
| AgentTown | resources/agent-town-dist/ | Next.js standalone build output; original TypeScript source is not present here |
| Packaged Electron archive | resources/app.asar | Generated/bundled application payload |
| Compiled Electron main | resources/main.jsc | V8 bytecode; not TypeScript source |
| Embedded Python native modules, browser engines and model data | resources/hermes-runtime/python/, resources/browsers/, resources/computer-runtime/ | Mix of source, compiled native code and data; licenses vary |

## Build the maintained desktop shell

From the repository root, with Node.js 22+ and npm:

~~~powershell
npm run dev
~~~

For a staging build and regression checks:

~~~powershell
npm test
npm run check:knockdesk
~~~

The builder compiles the Electron TypeScript, builds the dedicated desktop renderer, verifies expected outputs, and stages them under staging/electron-main/. It preserves KnockDesk.exe, resources/app.asar, and resources/main.jsc. Where a local Hermes virtual environment is present, it can be copied as part of the source staging layout; the builder does not synthesize a missing virtual environment or sign an installer. See the console warning and generated build manifest for runtime availability.

The source-owned desktop renderer is not the same as the legacy shipped dashboard. Do not overwrite the legacy archive until the feature set has been compared and a packaged Windows test succeeds.

## Inspect and unpack app.asar

1. Make sure Git LFS is installed and fetches actual payloads:

   ~~~powershell
   git lfs install
   git lfs pull
   ~~~

2. List the archive without modifying it:

   ~~~powershell
   npm run list:asar
   ~~~

3. Extract the archive into an ignored inspection directory:

   ~~~powershell
   npm run unpack:asar
   ~~~

   The default output is resources/app.asar.extracted/. The helper refuses to overwrite an existing extraction unless --force is passed.

4. Repack an edited extraction as a separate archive:

   ~~~powershell
   npm run repack:asar
   ~~~

   Output is resources/app.rebuilt.asar; the original resources/app.asar is never overwritten by the helper. Review and test the rebuilt archive before swapping it into any installation.

Extracted renderer bundles may be minified JavaScript rather than original source. Extraction provides access to archived files but cannot recreate missing source maps, TypeScript or original component boundaries. For maintained, testable UI work, edit the source-owned React renderer and rebuild it instead.

## What cannot be recovered automatically

- resources/main.jsc is V8 bytecode produced from a previous build. It is not a source archive. Keep it as a protected release artifact and rebuild only from the maintained entry point after verifying feature parity.
- resources/agent-town-dist/ contains a standalone Next.js output and bundled server, not the original AgentTown source repository.
- Native .node / .pyd modules, executables, browser engines, trained data, ICU files and model payloads are not ordinary source text. Their source may exist upstream, but it must be retrieved and built according to the relevant license and toolchain.
- Remote dashboards, provider APIs, hosted WorldMonitor content, Supabase projects and messaging providers are external systems; their server-side code is not contained in this repository.

## Git LFS notes

Large binary paths use Git LFS. A pointer is a small text file describing a binary object; it is not the artifact itself. LFS integrity checks in CI validate pointer patterns, while the Windows packaged-artifact job checks that the actual payload has been fetched. Never replace an LFS pointer with a truncated or empty placeholder.

## Validation coverage and release gate

CI exercises source/build-contract tests, web type checks and tests, desktop renderer lint/build, Python syntax/security tooling, dependency audit, LFS pointer integrity, packed archive integrity, and a Windows renderer smoke test. Optional sidecars, credentials, voice devices, remote messaging, all model providers and every packaged legacy screen require separate integration tests.

Before calling a build a release, require all of the following:

- A green current CI run, including the Windows renderer smoke test and packed-artifact integrity check.
- A repeatable build from a clean checkout with the expected LFS payloads.
- Runtime readiness tests for Hermes and AgentTown, not just the static renderer.
- A feature-parity comparison against the existing packaged UI.
- License/provenance review for the unresolved NOTICE items.
- An installer/portable package test that preserves user data on upgrade and uninstall.
