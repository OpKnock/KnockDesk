# Packaging decision: NSIS offline installer and an MSIX Store submission

Date: 2026-10-21 (revised; originally 2026-10-17). Status: DECIDED. Artifacts:
`installer/nsis/knockdesk-setup.nsi`, `scripts/build-nsis-installer.ps1`,
`scripts/build-msix.mjs`, `dist/` output (git-ignored, checksummed).

## Decision
Ship Windows releases as **both**:

- a **standalone offline NSIS installer** (`KnockDesk-Setup-<version>-x64.exe`),
  per-user, no admin required â€” the direct download, and the artifact that
  runs today;
- an **MSIX package** (`KnockDesk-<version>-x64.msix`) for submission to the
  Microsoft Store through Partner Center, built with `node scripts/build-msix.mjs --skip-sign`.

Keep the portable zip as a secondary artifact. NEVER submit a web downloader
as the Store package.

## The two packages are different things, and they are not interchangeable

| | NSIS installer | MSIX Store package |
|---|---|---|
| Built by | `scripts/build-nsis-installer.ps1` | `scripts/build-msix.mjs` |
| Identity | none (it is a plain installer) | the name and publisher Partner Center assigned |
| Signing | Authenticode, at build time, with the release certificate | **unsigned**: Microsoft signs it after it accepts the submission |
| Install | runs today, from the release page | from the Microsoft Store, once it is certified |
| Payload | the whole tree | the whole tree |

They carry the same payload: the build takes it from the same staging tree
(`staging/nsis-stage`), so the asar, the unpacked native modules, the Python
and Hermes runtimes, the bundled browsers, the locales and the audio are
identical.

## The Store identity is not ours to choose
Partner Center assigns the package identity name and the publisher
distinguished name, and compares the manifest against them byte for byte,
including capitalisation and punctuation. The package family name is derived
from those two values and is never written by hand.

A Store build therefore uses:

- `Name="OpKnock.KnockDesk"`
- `Publisher="CN=13E3D3C2-988F-4109-AD0E-42DE8604237C"`

and it is submitted **unsigned**. Signing it with a personal certificate
first would contradict the publisher the manifest declares and the package
would be rejected. A Store build refuses to run when `SIGN_PFX` or
`SIGN_PFX_PASSWORD` is set, so a Store package cannot be signed by accident.

A Store build is the **default**: `node scripts/build-msix.mjs` declares the
Partner Center identity. Building the wrong identity is the easiest way to
get a package rejected, so the correct one is what you get unless you ask
for something else.

A sideload build (`node scripts/build-msix.mjs --sideload`) keeps the
personal identity and the certificate in `installer/msix-publisher.txt`. It
is written to `dist/KnockDesk-<version>-x64-sideload.msix` so the two can
never be confused. Note that a package signed with a certificate that is not
in the Windows trusted root list will not install on a machine that does not
trust that certificate â€” `Add-AppxPackage` rejects it with 0x800B010A â€” so
the sideload build is for testing, not for distribution.

## Why NSIS first
- Handles 2GB+ payloads, sidecars, and per-user installs without elevation.
- Differential updates later via electron-updater; per-user SU credentials stay local.
- Unsigned builds still install (with SmartScreen warning) so QA can verify
  the exact release candidate before signing.
- Supports silent install/uninstall (`/S`), Start Menu + desktop shortcuts,
  Add/Remove Programs registration, and clean upgrade over the same
  directory. User data (`%APPDATA%\knockdesk`) lives outside the install
  directory and is preserved across upgrade and uninstall; the first run of
  this build also migrates a legacy `%APPDATA%\KnockDesk` profile into it.

## Why not a web downloader
Store policy requires the submitted installer to be standalone/offline and to
install the exact certified binaries. A downloader also breaks checksums,
offline installs, and reproducible verification.

## Signing path (no secrets in repo)
`scripts/sign-release.ps1` signs the exe + installer when a production
certificate is present via environment/secret store, and refuses otherwise
(no self-signed certs committed, no credentials in Actions). CI builds and
verifies the UNSIGNED installer; a separate gated job signs only when
`WINDOWS_CERT_PFX_B64` + `WINDOWS_CERT_PASSWORD` secrets exist.

## Payload note (why the release installer is host-built)
The Hermes venv, the computer-use venv, the hermes `src/node_modules` tree,
and the dashboard dists are git-ignored build-host trees (hundreds of MB,
never committed). The CI workflow can rebuild all of them from committed
sources (`scripts/requirements-windows-hermes.txt` and
`requirements-windows-computer.txt` are exact freezes of the shipped venvs;
the dashboard bundles come from the npm workspace builds), so a tag build
now produces a complete installer; the build script verifies the payloads
after staging and refuses to package without them. The v3.1.12 release
installer is the host-built one that was additionally smoke-tested by a real
install and uninstall cycle.
