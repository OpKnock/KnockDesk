# Packaging decision: NSIS offline installer (not MSIX, not web downloader)

Date: 2026-10-17. Status: DECIDED. Artifacts: `installer/nsis/knockdesk-setup.nsi`,
`scripts/build-nsis-installer.ps1`, `dist/` output (git-ignored, checksummed).

## Decision
Ship Windows releases as a **standalone offline NSIS installer**
(`KnockDesk-Setup-<version>-x64.exe`), per-user, no admin required.
Keep the portable zip as a secondary artifact. Do NOT pursue MSIX/Store
packaging until the prerequisites below are met, and NEVER submit a web
downloader as the Store package.

## Why not MSIX (yet)
1. No production signing identity. MSIX requires a trusted certificate whose
   subject matches the package publisher; we ship unsigned today.
2. 2GB+ single payload with embedded Chromium, Python, and sidecar processes
   (dashboard, AgentTown, bridges) conflicts with MSIX container rules and
   Store size/update expectations.
3. The main process is bytenode bytecode (`resources/main.jsc`) rebuilt only
   from the maintained source shell after feature-parity verification, which
   is still open (see docs/BUILD_AND_SOURCE_MAP.md).
4. No clean file-type/protocol associations manifest yet; no declared
   restricted capabilities inventory.

## Why not a web downloader
Store policy requires the submitted installer to be standalone/offline and to
install the exact certified binaries. A downloader also breakschecksums,
offline installs, and reproducible verification.

## Why NSIS now
- Handles 2GB+ payloads, sidecars, and per-user installs without elevation.
- Differential updates later via electron-updater; per-user SU credentials stay local.
- Unsigned builds still install (with SmartScreen warning) so QA can verify
  the exact release candidate before signing.
- Supports silent install/uninstall (`/S`), Start Menu + desktop shortcuts,
  Add/Remove Programs registration, and clean upgrade over the same
  directory. User data (`%APPDATA%\knockdesk`) lives outside the install
  directory and is preserved across upgrade and uninstall; the first run of
  this build also migrates a legacy `%APPDATA%\stonic_gen3` profile into it.

## Signing path (blocked, no secrets in repo)
`scripts/sign-release.ps1` signs the exe + installer when a production
certificate is present via environment/secret store, and refuses otherwise
(no self-signed certs committed, no credentials in Actions). CI builds and
verifies the UNSIGNED installer; a separate gated job signs only when
`WINDOWS_CERT_PFX_B64` + `WINDOWS_CERT_PASSWORD` secrets exist.
