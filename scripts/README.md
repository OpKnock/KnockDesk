# Maintenance and Validation Tools

Run these commands from the repository root. On Windows, use PowerShell with Node.js 22+, npm, Python 3.11, and Git LFS installed.

## Quick validation

```powershell
npm test
npm run check:knockdesk
npm run check:privacy
npm run check:secrets
npm run test:maintenance
```

## Build and runtime validation

| Tool | Responsibility |
|---|---|
| `scripts/build-pipeline.test.mjs` | Source/build-contract regression tests |
| `scripts/dev-knockdesk.mjs` | One-command source-shell development launcher |
| `scripts/source_desktop_smoke_test.py` | Windows smoke test for the Electron shell and React renderer |
| `scripts/smoke_test.py` | Smoke test for the packaged app; requires real Git LFS payloads |
| `scripts/health_check.py` | Diagnoses a running packaged app via Chromium DevTools |
| `scripts/uninstall_verify.py` | Checks uninstall behavior and user-data retention |

## Privacy and inventory

| Command | Output |
|---|---|
| `npm run check:privacy` | Reports likely email-address and absolute-home-path leaks in selected first-party text files |
| `npm run check:secrets` | Reports redacted matches for known API-key patterns |
| `npm run inventory` | Writes a file/size report to `staging/INVENTORY.md` |

These are targeted scanners, not proof that binary metadata, generated bundles, Git history, upstream code, or every third-party payload is free of secrets or personal data.

## Archive inspection

For the primary Electron archive, fetch actual LFS payloads and run:

```powershell
git lfs install
git lfs pull
npm run list:asar
npm run unpack:asar
npm run repack:asar
```

The helper writes extraction output to `resources/app.asar.extracted/` and a rebuilt copy to `resources/app.rebuilt.asar`; it never overwrites `resources/app.asar`.

For bulk inspection of ZIP, wheel, and Chromium PAK files, use `npm run unpack:all`. It may create a large amount of generated output. ZIP paths are validated before extraction, generated extraction folders are skipped on subsequent runs, and failures return a non-zero exit status.

A passing source-renderer smoke test does not prove that all model providers, messaging channels, voice devices, native modules, or optional sidecars operate correctly. See `docs/PRODUCT_READINESS_AUDIT.md` for release gates.
