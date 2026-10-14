# Validation and Maintenance Scripts

This directory contains the repository's source checks, archive tools, and Windows runtime smoke-test helpers.

| Script | Purpose |
|---|---|
| scripts/build-pipeline.test.mjs | Fast source/build contract regression tests |
| scripts/unpack-app-asar.mjs | Safely list, extract and repack an ASAR without overwriting the original |
| scripts/privacy-scan.py | Detect common email-address and machine-specific home-path leaks in first-party files |
| scripts/source_desktop_smoke_test.py | Launch Electron and exercise the source-owned desktop renderer on Windows |
| scripts/smoke_test.py | Smoke-test the existing packaged executable (requires a real LFS payload) |
| scripts/health_check.py | Diagnose an already-running packaged app through Chromium DevTools |
| scripts/uninstall_verify.py | Verify uninstall behavior and user-data retention |
| scripts/inventory.py / scripts/regen-logo-assets.py | Repository inventory and brand asset maintenance |

## Quick checks

From the repository root:

~~~powershell
npm test
python scripts/privacy-scan.py
~~~

For the source-owned shell, use npm run dev or npm run check:knockdesk. GitHub Actions runs additional workspace and Windows checks; a passing source-renderer smoke test is not proof that every provider and optional sidecar is operational.

For the packaged binary, first run git lfs pull. See Build and source map in the docs directory for ASAR extraction and release limitations.
