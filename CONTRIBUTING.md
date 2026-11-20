# Contributing to KnockDesk

Thank you for helping improve KnockDesk. This repository combines KnockDesk-authored desktop-shell code with a substantial upstream Hermes runtime, native dependencies, and packaged application assets. Keep those ownership and licensing boundaries clear when proposing changes.

## Development requirements

- Windows 10 or Windows 11 for desktop runtime checks.
- Node.js 22 or later and npm.
- Python 3.11 for repository maintenance checks.
- Git LFS for retrieving packaged executable and archive payloads.

Clone the repository and fetch the actual binary assets:

```powershell
git lfs install
git clone https://github.com/OpKnock/KnockDesk.git
cd KnockDesk
git lfs pull
```

## Validate changes

Run from the repository root:

```powershell
npm test
npm run check:knockdesk
npm run check:privacy
npm run check:secrets
npm run test:maintenance
```

For desktop renderer changes, also run the workspace checks documented in the [README](README.md). The Windows smoke test is run in GitHub Actions. Runtime-backed features still require manual or integration tests with an appropriately configured local Hermes installation.

## Contribution expectations

1. Describe the bug, behavior change, user impact, and test results clearly.
2. Keep changes focused and avoid unrelated refactors.
3. Do not commit API keys, access tokens, local machine paths, private logs, user data, or generated runtime state.
4. Preserve upstream copyright notices, license texts, and NOTICE files. Do not copy assets or source unless their licensing and provenance permit the intended use.
5. Keep generated bundles, extracted archives, and local backups out of commits unless they are intentional, licensed release assets.
6. Update user-facing documentation when commands, configuration, privacy behavior, compatibility, or supported features change.
7. Do not describe the product as production-ready until the applicable release checks in `docs/PRODUCT_READINESS_AUDIT.md` are complete.

## Reporting issues

For ordinary defects and feature requests, use the repository's GitHub Issues. Before attaching logs or configuration files, remove credentials, user-specific paths, email addresses, and other private information. For security-sensitive reports, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
