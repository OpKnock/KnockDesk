# Protected core

KnockDesk ships a small set of files that make up the launch path and the
runtime services: the compiled entry (`electron/main.jsc`) plus the bridge,
plugin, bootstrap, remote-handler, Hermes, computer, and CDP modules. The
protected core keeps those files encrypted at rest and verifies them before
they load.

## What this protects against

- Reading or copying the app's own logic from the installed folder at rest
  (a hex editor, an archive diff, a copied `resources` folder).
- Copying an installation to another machine or Windows account and running
  the protected files there: the key is wrapped by DPAPI for the installing
  account and does not unwrap anywhere else.
- Silent modification: every protected entry is hashed against a manifest
  that ships inside the archive. A changed, replaced, truncated, or missing
  entry is reported at boot and recorded, instead of loading whatever is on
  disk.

## What this does not protect against

- The user themselves, an administrator on the same machine, or anyone who
  can run code as that user: they can call the same DPAPI unwrap the app
  calls, and the plaintext must exist in memory for V8 to execute it.
- Anyone who can rewrite the archive: they can rewrite the manifest too. The
  manifest is tamper-evident, not tamper-proof. Real prevention is
  Authenticode signing of the installer and executable (docs/ops/signing.md)
  plus Windows' own trust checks.
- Server-side secrets. Anything that must stay secret from a determined
  local user belongs on a server; local encryption cannot beat memory
  inspection by the machine's owner.

## Format

Each protected entry carries a reserved 32-byte prefix, so the entry name
never changes (Node picks its module handler from the file name, so a `.enc`
suffix would stop the bytecode from loading at all):

```
plaintext build  [32 zero bytes][payload unchanged]
encrypted build  'KD01' + [12-byte IV][16-byte GCM tag][ciphertext]
```

The launch shim wraps `fs.readFileSync`, `fs.readFile`, and
`fs.createReadStream` for exactly these paths, strips the prefix or
decrypts with AES-256-GCM, and hands the plaintext to the loader without
ever writing it to disk.

## Key custody

- The build never ships a key. The release archive contains the
  plaintext-padded layout only.
- The installer runs `resources/protect-core.mjs` after copying files. It
  generates a fresh 256-bit key per installation, encrypts the reserved
  payloads in place (same byte length, the archive layout never moves), and
  stores the key in the user profile:
  - `core-key.dpapi.bin`: DPAPI `CurrentUser` wrap, what the app boots from.
  - `core-key.raw`: recovery copy, for the user to keep somewhere safe or
    delete once the install is verified.
- At boot the shim resolves the key in this order:
  1. `KNOCKDESK_CORE_KEY_FILE=<path to 32 raw bytes>` when set (development
     and manual recovery).
  2. `core-key.dpapi.bin`: DPAPI `CurrentUser` wrap, what a normal install
     boots from. If this blob cannot be unwrapped, the failure is reported in
     the log instead of being silent.
  3. `core-key.raw`: the raw recovery copy, used only when the wrapped key is
     not readable, with a log line saying so. Deleting it makes the DPAPI blob
     the only local copy, which is the stronger default.
- `protect-core.mjs` writes the blob and then reads it back through DPAPI, so
  a wrap the machine cannot unwrap is caught at install time rather than at
  first boot. `scripts/security/protect-key.ps1` does the same wrap for an
  existing `core-key.raw` (repair path).

If the key is lost, the encrypted files cannot be read. The recovery path is
to reinstall from the installer, which copies the plaintext-padded layout
again and encrypts it with a new key.

## Integrity manifest

`electron/integrity-manifest.json` ships inside the archive: SHA-256 for
every entry, plus the list of protected entries. At boot the shim re-hashes
the protected entries and compares. On mismatch it logs one line (paths and
counts only, no contents, no keys), appends details to
`%APPDATA%\knockdesk\logs\integrity.log`, and continues - the app degrades
rather than refusing to start. The report is meant for the repair path
(reinstall), not for automatic deletion of anything.

Escape hatches: `KNOCKDESK_TRUST_CORE=1` skips the check for knowingly
modified local builds; `KNOCKDESK_NO_CORE_DECRYPT=1` disables the read hooks
on a plaintext build.

## Build flow

```
# release archive (plaintext-padded, manifest included):
node scripts/security/build-encrypted.mjs $TEMP/kd-extract resources/app.asar --plain

# lab verification of the encrypted boot path (development key):
node scripts/security/build-encrypted.mjs $TEMP/kd-extract $TEMP/app.enc.asar $TEMP/core-test.key
KNOCKDESK_CORE_KEY_FILE=$TEMP/core-test.key <installed exe>

# what the installer runs (same script the release ships):
set ELECTRON_RUN_AS_NODE=1
KnockDesk.exe resources\protect-core.mjs resources\app.asar
```

Gate checks: `scripts/rebrand/full-compare.mjs <oldAsar> <newAsar>` asserts
that no unplanned bytes differ (it verifies that padded entries keep a
byte-identical payload) and `scripts/rebrand/repack-rebrand.mjs` re-checks
the frozen bytecode, loader, throttle sources, and manifest coverage.
