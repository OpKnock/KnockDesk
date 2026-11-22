'use strict';

/**
 * KnockDesk launch shim.
 *
 * The shipped app entry is a V8 bytecode bundle (main.jsc) compiled before the
 * product was renamed from "Stonic" to "KnockDesk". Bytecode string tables
 * cannot be edited safely, so this plain-JavaScript entry file (which IS
 * editable) ports the launch path instead. It runs before the legacy bundle
 * is required and does five things:
 *
 *  1. Redirects legacy folder/file names the bytecode builds via path.join:
 *        Documents/Stonic Data      -> Documents/KnockDesk Data
 *        Documents/Stonic Data/Stonic_Vault -> .../KnockDesk_Vault
 *        stonic_main.log            -> knockdesk_main.log
 *        %APPDATA%/stonic_gen3      -> %APPDATA%/knockdesk
 *  2. Runs a one-time, per-file-if-missing merge copy of the legacy
 *     %APPDATA%/stonic_gen3 profile into %APPDATA%/knockdesk (caches skipped),
 *     plus the whitelisted Documents/Stonic Data files (SOUL.md, MEMORY.md,
 *     *.md/*.json, skills/) so no user data is orphaned by the rename.
 *  3. Pins Electron's userData to %APPDATA%/knockdesk and keeps it pinned
 *     even if the legacy bundle later asks for a Stonic-named profile.
 *  4. Publishes KNOCKDESK_* <-> STONIC_* environment aliases in both
 *     directions so configs written under either naming keep working.
 *  5. Still requires the unchanged main.jsc - the product behaviour is
 *     byte-for-byte what shipped, only the visible paths and names move.
 *
 * Escape hatches (env):
 *   KNOCKDESK_SKIP_LEGACY_PORT=1     - run the untouched legacy behaviour.
 *   KNOCKDESK_SKIP_LEGACY_MIGRATION=1 - keep the path remap and userData pin,
 *     but skip every file copy (used by smoke tests so they never touch the
 *     real profile before the formal first-run migration).
 *
 * Identifiers inside the bytecode that are tightly coupled to live
 * infrastructure (cloud-gateway URL, gateway model ids, crypto format tag,
 * scheme id "stonic-media", compiled log labels) are intentionally left
 * as-is: renaming them would break live services, not appearance.
 */
require('bytenode');

(function portToKnockDesk() {
  try {
    if (process.env.KNOCKDESK_SKIP_LEGACY_PORT === '1') return; // dev escape hatch: untouched legacy behaviour
    const skipMigration = process.env.KNOCKDESK_SKIP_LEGACY_MIGRATION === '1'; // test hatch: remap+pin only, no copies

    const path = require('path');
    const fs = require('fs');
    const { app } = require('electron');

    // Original, unpatched join for this shim's own path arithmetic.
    const origJoinFn = path.join;

    // ---- 1. Legacy-name remap for every path.join result -----------------
    const REPLACEMENTS = [
      ['Stonic Data', 'KnockDesk Data'],
      ['stonic_main.log', 'knockdesk_main.log'],
      ['stonic_main', 'knockdesk_main'],
      ['Stonic_Vault', 'KnockDesk_Vault'],
      ['stonic_gen3', 'knockdesk'],
      ['stonic-gen3', 'knockdesk'],
    ];

    const remap = (p) => {
      if (typeof p !== 'string' || p.toLowerCase().indexOf('stoni') === -1) return p;
      let out = p;
      for (const [from, to] of REPLACEMENTS) out = out.split(from).join(to);
      return out;
    };

    const patchedJoin = function patchedJoin(...args) {
      try {
        return remap(origJoinFn.apply(null, args));
      } catch {
        return origJoinFn.apply(null, args);
      }
    };
    try { path.join = patchedJoin; } catch {}
    try { if (path.posix) path.posix.join = patchedJoin; } catch {}
    try { if (path.win32) path.win32.join = patchedJoin; } catch {}

    // ---- 2. Profile port: %APPDATA%/stonic_gen3 -> %APPDATA%/knockdesk ---
    const appData = app.getPath('appData');
    const targetProfile = origJoinFn(appData, 'knockdesk');

    let legacyProfile = null;
    for (const name of ['stonic_gen3', 'knockdesk ai', 'stonic-gen3']) {
      const candidate = origJoinFn(appData, name);
      if (candidate !== targetProfile && fs.existsSync(candidate)) { legacyProfile = candidate; break; }
    }

    const SKIP_DIRS = new Set([
      'Cache', 'Code Cache', 'GPUCache', 'VideoDecodeStats',
      'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
      'blob_storage', 'Service Worker', 'SharedStorage', 'Shared Dictionary',
      'shared_proto_db', 'logs', 'Crashpad', 'Crash Reports', 'CrashpadMetrics',
    ]);
    const SKIP_FILES = new Set([
      'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket',
      'DevToolsActivePort',
    ]);

    function copyTree(srcDir, dstDir) {
      try { fs.mkdirSync(dstDir, { recursive: true }); } catch {}
      let entries = [];
      try { entries = fs.readdirSync(srcDir); } catch { return; }
      for (const name of entries) {
        const src = origJoinFn(srcDir, name);
        const dst = origJoinFn(dstDir, name);
        try {
          const st = fs.lstatSync(src);
          if (st.isFile()) { if (!fs.existsSync(dst)) fs.copyFileSync(src, dst); }
          else if (st.isDirectory()) copyTree(src, dst);
        } catch {}
      }
    }

    try {
      if (legacyProfile && !skipMigration) {
        fs.mkdirSync(targetProfile, { recursive: true });
        const entries = fs.readdirSync(legacyProfile);
        for (const name of entries) {
          const src = origJoinFn(legacyProfile, name);
          const dst = origJoinFn(targetProfile, name);
          try {
            const st = fs.lstatSync(src);
            if (st.isFile()) {
              if (SKIP_FILES.has(name) || fs.existsSync(dst)) continue;
              fs.copyFileSync(src, dst);
            } else if (st.isDirectory()) {
              if (SKIP_DIRS.has(name)) continue;
              copyTree(src, dst);
            }
          } catch {}
        }
        console.log('[KnockDesk] Ported legacy profile ->', targetProfile);
      }
    } catch (err) {
      console.warn('[KnockDesk] Legacy profile port skipped:', (err && err.message) || err);
    }

    // 2b. Bridge key continuity: whatever key file the legacy eras wrote,
    //     the new animal is knockdesk-bridge-key (what the bridge reads).
    try {
      const dstKey = origJoinFn(targetProfile, 'knockdesk-bridge-key');
      if (legacyProfile && !skipMigration && !fs.existsSync(dstKey)) {
        let newest = null;
        let newestMtime = -1;
        for (const cand of [
          'knockdesk-bridge-key', 'knockdesk-ai-bridge-key', 'knockdesk ai-bridge-key',
          'stonic-bridge-key', 'stonic-ai-bridge-key', 'stonic ai-bridge-key',
        ]) {
          try {
            const p = origJoinFn(legacyProfile, cand);
            const st = fs.statSync(p);
            if (st.isFile() && st.mtimeMs > newestMtime) { newest = p; newestMtime = st.mtimeMs; }
          } catch {}
        }
        if (newest) fs.copyFileSync(newest, dstKey);
      }
    } catch {}

    // ---- 3. Pin userData at %APPDATA%/knockdesk --------------------------
    try { app.setPath('userData', targetProfile); } catch {}
    const desiredUserData = targetProfile;
    try {
      const origSetPath = app.setPath.bind(app);
      app.setPath = function patchedSetPath(name, p) {
        if (name === 'userData'
          && typeof p === 'string'
          && p !== desiredUserData
          && /stonic[-_]gen3/i.test(p)) {
          console.warn('[KnockDesk] Redirected legacy userData request ->', desiredUserData);
          return origSetPath(name, desiredUserData);
        }
        return origSetPath(name, p);
      };
    } catch {}

    // ---- 4. Environment aliases, both directions -------------------------
    try {
      for (const key of Object.keys(process.env)) {
        if (key.indexOf('STONIC_') === 0) {
          const modern = 'KNOCKDESK_' + key.slice(7);
          if (!(modern in process.env)) process.env[modern] = process.env[key];
        } else if (key.indexOf('KNOCKDESK_') === 0) {
          const legacy = 'STONIC_' + key.slice(10);
          if (!(legacy in process.env)) process.env[legacy] = process.env[key];
        }
      }
    } catch {}

    // ---- 5. Documents/Stonic Data -> Documents/KnockDesk Data (files) ----
    try {
      const documents = app.getPath('documents');
      const legacyDocs = origJoinFn(documents, 'Stonic Data');
      const docsDest = origJoinFn(documents, 'KnockDesk Data');
      if (legacyDocs && fs.existsSync(legacyDocs) && !skipMigration) {
        if (!fs.existsSync(docsDest)) fs.mkdirSync(docsDest, { recursive: true });
        let entries = [];
        try { entries = fs.readdirSync(legacyDocs); } catch {}
        for (const name of entries) {
          try {
            const src = origJoinFn(legacyDocs, name);
            const st = fs.lstatSync(src);
            if (st.isFile()) {
              if (/^stonic_main\.log$/i.test(name)) continue; // logs stay behind
              if (/^knockdesk_main\.log$/i.test(name)) continue;
              if (!/\.(md|json|txt)$/i.test(name) && name !== 'Stonic_Vault') continue;
              const dstName = name === 'Stonic_Vault' ? 'KnockDesk_Vault' : name;
              const dst = origJoinFn(docsDest, dstName);
              if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
            } else if (st.isDirectory() && /^skills$/i.test(name)) {
              const dst = origJoinFn(docsDest, name);
              if (!fs.existsSync(dst)) copyTree(src, dst);
            }
          } catch {}
        }
      }
    } catch (err) {
      console.warn('[KnockDesk] Documents port skipped:', (err && err.message) || err);
    }
  } catch (err) {
    try { console.error('[KnockDesk] Launch shim failed, continuing with legacy paths:', (err && err.message) || err); } catch {}
  }
})();

require('./main.jsc');
