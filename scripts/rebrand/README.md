# Rebrand tooling (Stonic to KnockDesk)

Provenance for the naming cleanup that ships in `resources/app.asar`
(3.1.12). The shipped app entry is a V8 bytecode bundle (`main.jsc`)
compiled before the product was renamed; its string tables cannot be
edited safely. The plain-JavaScript layers around it can.

## Files

- `launch-shim.js` — the exact file that now sits at `electron/main.js`
  inside the asar. It runs before `main.jsc` is required and:
  1. monkey-patches `path.join` results so the legacy bundle's
     `Documents\Stonic Data`, `Stonic_Vault`, `stonic_main.log`, and
     `%APPDATA%\stonic_gen3` paths resolve to the KnockDesk names;
  2. runs a one-time, per-file-if-missing profile migration
     (`stonic_gen3` -> `knockdesk`, caches skipped, bridge-key
     continuity);
  3. pins Electron `userData` and guards later `app.setPath` calls;
  4. aliases environment variables in both directions
     (`KNOCKDESK_*` <-> `STONIC_*`) so configs under either name work.
  Escape hatches: `KNOCKDESK_SKIP_LEGACY_PORT=1` (untouched legacy
  behavior) and `KNOCKDESK_SKIP_LEGACY_MIGRATION=1` (remap and pin
  only, no file copies; used by smoke tests).
- `repack-rebrand.mjs` — packs a patched extraction into a new asar and
  gates it: entry count and file list identical to the shipped archive,
  `main.jsc` byte-identical, loader present, service patches present,
  and the CI brand-guard simulation on the first 1 MB.
- `full-compare.mjs` — byte-compares every entry of the new asar against
  the previous one and asserts that only the 15 intended files differ.

## Rebuild procedure

1. Extract the shipped asar (`npx @electron/asar extract`).
2. Apply `launch-shim.js` as `electron/main.js`.
3. Apply the service-layer patches listed in the 3.1.12 release notes
   (the same string shapes are mirrored in
   `resources/hermes-runtime/src/electron/services/`).
4. `node scripts/rebrand/repack-rebrand.mjs` then
   `node scripts/rebrand/full-compare.mjs` before replacing
   `resources/app.asar`.

`@electron/asar@3.2.18` is required: version 4 dedupes entries by
integrity hash, which changes byte layout of untouched files.

## Module renames (safe subset)

Four shipped modules carry the KnockDesk file names, because the compiled
entry requires them under the legacy names:

| Legacy file | Ships as |
|---|---|
| `electron/services/stonic-bridge.js` | `knockdesk-bridge.js` |
| `electron/services/stonic-plugin.js` | `knockdesk-plugin.js` |
| `electron/main/bootstrap/stonic-bootstrap.js` | `knockdesk-bootstrap.js` |
| `electron/main/ipc/stonic-remote-handlers.js` | `knockdesk-remote-handlers.js` |

Section 7 of the shim installs a `Module._resolveFilename` alias that maps
the legacy request to the new file **before** `main.jsc` is required, so the
bytecode keeps resolving them. The map is exact and a failed mapping falls
back to the original request, so a bad rename cannot brick boot; it would
only fail the way it would have without the alias.

The modules already expose KnockDesk primary names (`KnockDeskBridge`,
`ensureKnockDeskDirectories`, ...) with `Stonic*` aliases kept for the
bytecode's destructuring, so those names cannot be dropped.

## What cannot be renamed, and why

All of these are referenced by exact string inside `electron/main.jsc`,
which is compiled V8 bytecode and cannot be edited:

- **IPC channels** `stonic-cloud-token`, `stonic-cloud-device-key-get`,
  `-save`, `-clear`, `stonic-cloud-supabase-config`,
  `stonic-cloud-token-refresher`. The bytecode registers the handler; the
  renderer invokes the same name. Renaming needs both sides remapped, and
  cloud sync cannot be verified end to end from a dev machine.
- **`stonic-dpapi-v1`** is the version tag written inside encrypted blobs.
  Renaming it makes existing users' encrypted data undecryptable.
- **`stonic-media`** is a custom Chromium scheme registered by the bytecode
  and used to build URLs in the renderer.
- **`STONIC_SUPABASE_URL`, `STONIC_SUPABASE_ANON_KEY`, `STONIC_CLOUD_GATEWAY`,
  `STONIC_MEMORY`** config keys, and the `STONIC_CHARACTERS_V1` family of
  localStorage keys. Renaming them orphans every existing user's saved
  persona, characters, and cloud configuration unless a one-time migration
  ships first.
- **Tier 4 migration identifiers** (`Stonic Data`, `Stonic_Vault`,
  `stonic_main.log`, `stonic_gen3`, `stonic-gen3`, the three bridge-key
  candidates). These exist to find legacy data; renaming them destroys the
  ability to find it.
- **Boot-log prefixes** (`[Stonic Logger]`, `[Stonic Dev]`, `Stonic Chromium`)
  come from the bytecode's own string table.

The renderer bundle's log prefixes (`[STONIC-VOICE]` and friends) were
renamed to `[KNOCKDESK-*]`, since those strings are inert text.
