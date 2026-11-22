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
