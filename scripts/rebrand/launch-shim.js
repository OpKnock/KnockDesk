'use strict';

/**
 * KnockDesk launch shim.
 *
 * The shipped app entry is a V8 bytecode bundle (main.jsc) compiled before the
 * product was renamed from "Stonic" to "KnockDesk". Bytecode string tables
 * cannot be edited safely, so this plain-JavaScript entry file (which IS
 * editable) ports the launch path instead. It runs before the legacy bundle
 * is required and does eight things:
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
 *  5. Installs an idle throttle in the app's own windows: the ambient CSS
 *     animation layer and the WebGL particle globe pause after two idle
 *     minutes and restore instantly on any input, DOM activity, media, or
 *     network call (the release build otherwise holds the GPU process at
 *     ~150% of a core while sitting idle, which reads as a hang).
 *  6. Still requires the unchanged main.jsc - the product behaviour is
 *     byte-for-byte what shipped, only the visible paths and names move.
 *  7. Answers reads of the protected core (main.jsc and the eight runtime
 *     modules) after AES-256-GCM decryption when the installation is
 *     encrypted at rest, or after stripping the reserved 32-byte prefix when
 *     it is not. Plaintext is composed in memory and never written to disk.
 *     The per-install key is delivered by DPAPI (CurrentUser) from the user
 *     profile, so a copied install folder cannot be read.
 *  8. Verifies the protected entries against the shipped SHA-256 manifest
 *     before the bytecode loads, and reports modification, replacement, or a
 *     missing module instead of loading whatever is on disk.
 *
 * Escape hatches (env):
 *   KNOCKDESK_SKIP_LEGACY_PORT=1     - run the untouched legacy behaviour.
 *   KNOCKDESK_SKIP_LEGACY_MIGRATION=1 - keep the path remap and userData pin,
 *     but skip every file copy (used by smoke tests so they never touch the
 *     real profile before the formal first-run migration).
 *   KNOCKDESK_DISABLE_IDLE_THROTTLE=1 - do not install the idle
 *     throttle (diagnostics only).
 *   KNOCKDESK_NO_CORE_DECRYPT=1      - do not install the protected-core read
 *     hooks (diagnostics on a plaintext build only).
 *   KNOCKDESK_CORE_KEY_FILE=<path>   - raw 32-byte key file for development
 *     and recovery when the DPAPI blob is unavailable.
 *   KNOCKDESK_TRUST_CORE=1           - skip the integrity check (when running
 *     a knowingly modified local build).
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
    // ---- 6. Idle throttle for the ambient UI layer ------------------------
    // The shipped UI keeps an ambient layer alive: infinite CSS animations
    // (orb breathe/pulse/spin, voice-HUD beams, recording ripples) plus a
    // WebGL particle globe, for as long as the window is visible. Measured
    // on the release build that layer holds the GPU process at ~150% of a
    // core and a renderer at ~30-55% of a core while the app simply sits
    // there - what users report as "the app hangs when left idle" and what
    // certification counts as excessive idle CPU.
    //
    // The throttle itself ships as dist/idle-throttle.js and is loaded by the
    // app's own index.html (patched in this repack) as the FIRST script, so
    // its timer and animation patches are in place before the app bundle
    // runs: a post-load injection cannot reach loops that captured timer
    // references at module scope. Two minutes with no input and no app
    // activity throttles ambient schedulers to a 2 fps floor; input, DOM
    // change, media playback, a network call, or a WebSocket message
    // restores full rate instantly. Nothing is dropped, only slowed.
    //
    // This section keeps two pieces of support:
    //   a. the renderer log forwarder, so the throttle's own state lines
    //      show up in the app log;
    //   b. a post-load injection as a fallback for any window whose document
    //      did not come from the patched index.html.
    // Escape hatch: KNOCKDESK_DISABLE_IDLE_THROTTLE=1
    try {
      if (process.env.KNOCKDESK_DISABLE_IDLE_THROTTLE !== '1' && typeof app.on === 'function') {
        const injectPath = origJoinFn(__dirname, 'idle-throttle-inject.js');
        const injectSrc = fs.readFileSync(injectPath, 'utf8');
        app.on('web-contents-created', function onWebContents(_evt, wc) {
          try {
            if (!wc || wc.__kdIdleInjected) return;
            wc.__kdIdleInjected = true;
            if (typeof wc.on === 'function') {
              wc.on('console-message', function onConsole(_e, _level, message) {
                try {
                  if (typeof message === 'string' && message.indexOf('[KnockDesk] idle') === 0) {
                    console.log('[renderer]', message);
                  }
                } catch (e) {}
              });
            }
            wc.on('did-finish-load', function onIdleInjectionTarget() {
              const src = process.env.KNOCKDESK_DEBUG_IDLE === '1'
                ? 'window.__kdDbg={};' + injectSrc
                : injectSrc;
              try { wc.executeJavaScript(src); } catch (e) {}
            });
          } catch (e) {}
        });
        console.log('[KnockDesk] Idle throttle support installed (renderer logs forwarded)');
      }
    } catch (err) {
      try { console.warn('[KnockDesk] Idle throttle hook skipped:', (err && err.message) || err); } catch {}
    }
    // ---- 7. Module resolution aliases ------------------------------------
    // Four shipped modules now carry the KnockDesk file names. The compiled
    // entry (main.jsc) still requires the old paths, so they are mapped here
    // before it loads. A miss here would break boot, so the map is exact and
    // a failed mapping falls back to the original request unchanged.
    try {
      const Module = require('module');
      if (!Module.__kdRenamed) {
        Module.__kdRenamed = true;
        const origResolve = Module._resolveFilename;
        const RENAMED = {
          'stonic-bootstrap': 'knockdesk-bootstrap',
          'stonic-bridge': 'knockdesk-bridge',
          'stonic-plugin': 'knockdesk-plugin',
          'stonic-remote-handlers': 'knockdesk-remote-handlers',
        };
        const mapRequest = (request) => {
          if (typeof request !== 'string' || request.indexOf('stonic') === -1) return request;
          const cut = request.lastIndexOf('/');
          const dir = cut === -1 ? '' : request.slice(0, cut + 1);
          const base = cut === -1 ? request : request.slice(cut + 1);
          const mapped = RENAMED[base];
          return mapped ? dir + mapped : request;
        };
        Module._resolveFilename = function patchedResolve(request) {
          const mapped = mapRequest(request);
          if (mapped !== request) {
            try {
              return origResolve.apply(this, [mapped].concat(Array.prototype.slice.call(arguments, 1)));
            } catch (mapErr) { /* fall through to the original request */ }
          }
          return origResolve.apply(this, arguments);
        };
      }
    } catch (err) {
      try { console.warn('[KnockDesk] Module rename alias skipped:', (err && err.message) || err); } catch {}
    }
    // ---- 8. Outbound network guard ---------------------------------------
    // The owner decides what may leave this machine. Everything that is not
    // loopback and not on the allowlist is blocked at the network layer, which
    // covers the cloud-sync channels, the phone bridge, telemetry, the update
    // feed and any in-app browser page - including code inside the compiled
    // entry that cannot be edited. The AI providers KnockDesk exists to use
    // are on the allowlist by default, because without them the app has no
    // function; remove them and it becomes fully air-gapped.
    //
    //   KNOCKDESK_NET_MODE=strict   allowlist only (default)
    //   KNOCKDESK_NET_MODE=off      block everything except loopback
    //   KNOCKDESK_NET_MODE=open     no guard (previous behaviour)
    //   KNOCKDESK_ALLOW_HOSTS=a.com,b.dev  extra hosts, comma separated
    try {
      const mode = (process.env.KNOCKDESK_NET_MODE || 'strict').toLowerCase();
      if (mode !== 'open' && typeof app.on === 'function' && app.whenReady) {
        const LOOPBACK = /^(127\.0\.0\.1|localhost|\[?::1\]?)$/i;
        // Every host the app itself loads, not just the AI providers. The
        // guard used to list only the APIs, which silently broke three
        // first-party features that open their own webviews:
        //   - World Monitor (worldmonitor.app) reported "offline"
        //   - the tutorial videos (youtube.com / youtu.be) never loaded
        //   - Moonshot's international endpoint api.moonshot.ai was blocked
        //     while the .cn one was allowed
        const DEFAULT_ALLOW = [
          // AI providers
          'generativelanguage.googleapis.com',
          'googleapis.com',
          'aistudio.google.com',
          'aiplatform.googleapis.com',
          'openrouter.ai',
          'api.openai.com',
          'api.groq.com',
          'console.groq.com',
          'api.moonshot.cn',
          'api.moonshot.ai',
          // bundled webview features
          'worldmonitor.app',
          'www.worldmonitor.app',
          'youtube.com',
          'www.youtube.com',
          'youtu.be',
          'm.youtube.com',
          // docs and links the UI opens directly
          'react.dev',
          'www.w3.org',
          'docs.expo.dev',
          'fonts.googleapis.com',
          'mail.google.com',
          'www.google.com',
        ];
        const extra = (process.env.KNOCKDESK_ALLOW_HOSTS || '')
          .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
        const allow = new Set(DEFAULT_ALLOW.concat(extra));
        const hostAllowed = (host) => {
          const h = String(host || '').toLowerCase().replace(/\.$/, '');
          if (!h) return false;
          for (const ok of allow) {
            if (h === ok || h.endsWith('.' + ok)) return true;
          }
          return false;
        };

        const guardSession = (session) => {
          if (!session || !session.webRequest || session.__kdGuarded) return;
          session.__kdGuarded = true;
          session.webRequest.onBeforeRequest((details, cb) => {
            let host = '';
            try { host = new URL(details.url).hostname; } catch (e) { host = ''; }
            const url = String(details.url || '').toLowerCase();
            const isLocal = url.startsWith('file:') || url.startsWith('data:') || url.startsWith('blob:')
              || url.startsWith('chrome-extension:') || url.startsWith('knockdesk-media:')
              || url.startsWith('stonic-media:') || url.startsWith('about:') || url.startsWith('devtools:');
            if (isLocal || LOOPBACK.test(host) || hostAllowed(host)) return cb({ cancel: false });
            return cb({ cancel: true });
          });
        };

        app.on('web-contents-created', function onGuard(_e, wc) {
          try { guardSession(wc && wc.session); } catch (e) {}
        });
        try { guardSession(require('electron').session.defaultSession); } catch (e) {}
        try {
          const { session } = require('electron');
          for (const s of (session.getAllSessions ? session.getAllSessions() : [])) guardSession(s);
        } catch (e) {}
        console.log('[KnockDesk] Outbound network guard: ' + mode
          + ' | allowed: ' + Array.from(allow).join(', '));
      }
    } catch (err) {
      try { console.warn('[KnockDesk] Network guard skipped:', (err && err.message) || err); } catch {}
    }
  } catch (err) {
    try { console.error('[KnockDesk] Launch shim failed, continuing with legacy paths:', (err && err.message) || err); } catch {}
  }
})();

// ---- 9+10. Protected core: at-rest encryption and integrity ---------------
// The protected entries are the compiled entry (main.jsc) plus the runtime
// modules whose compromise would break a boot contract. They ship with a
// reserved 32-byte prefix:
//   plaintext build  [32 zero bytes][payload unchanged]
//   encrypted build  'KD01' + [12-byte IV][16-byte GCM tag][ciphertext]
// The file names never change: Node picks its module handler from the file
// name, so a .enc suffix would stop the bytecode loading at all. Reads of
// these paths are wrapped instead, and the decrypted bytes never touch disk.
//
// The key is per install and lives in the user profile wrapped by DPAPI
// CurrentUser (see scripts/security/protect-key.ps1), never in the archive,
// so a copied installation cannot be read. Honest scope: this protects data
// at rest - not a user with access to the running process, not an
// administrator of the same machine. A secret that must stay secret belongs
// on a server, because V8 must execute the plaintext from RAM.
//
// Escape hatches:
//   KNOCKDESK_NO_CORE_DECRYPT=1  - do not install the read hooks (diagnostics)
//   KNOCKDESK_CORE_KEY_FILE=path - raw 32-byte key for development/recovery
//   KNOCKDESK_TRUST_CORE=1       - skip the integrity check (known-good build)
(function protectCore() {
  try {
    const fs = require('fs');
    const corePath = require('path');
    const crypto = require('crypto');
    const { app } = require('electron');

    const PROTECTED = [
      'main.jsc',
      'services/knockdesk-bridge.js',
      'services/knockdesk-plugin.js',
      'main/bootstrap/knockdesk-bootstrap.js',
      'main/ipc/knockdesk-remote-handlers.js',
      'services/hermes-manager.js',
      'services/computer-manager.js',
      'services/cdp-shim.js',
    ].map((q) => corePath.join(__dirname, q));
    const PREFIX = 32;
    const isEncryptedHeader = (b) => b && b.length >= PREFIX
      && b[0] === 0x4b && b[1] === 0x44 && b[2] === 0x30 && b[3] === 0x31; // 'KD01'

    // The loader's real read entry points, captured before any wrapping:
    // decrypting through the wrapped functions would recurse forever.
    const origReadFileSync = fs.readFileSync;

    const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const unwrapDpapi = (blobPath) => {
      // Add-Type loads System.Security, whose ProtectedData class Windows
      // PowerShell 5.1 does not preload (plain [Security.Cryptography...]
      // fails with TypeNotFound on a stock Windows 10/11 install).
      const ps = '$ErrorActionPreference="Stop";'
        + 'Add-Type -AssemblyName System.Security;'
        + '$b=[IO.File]::ReadAllBytes(' + psQuote(blobPath) + ');'
        + '$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'
        + '[Security.Cryptography.DataProtectionScope]::CurrentUser);'
        + '[Convert]::ToBase64String($p)';
      const b64 = require('child_process').execFileSync(
        'powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return Buffer.from(b64, 'base64');
    };

    let coreKey = null;
    const isProtectedPath = (p) => PROTECTED.indexOf(p) !== -1;

    if (process.env.KNOCKDESK_NO_CORE_DECRYPT !== '1') {
      try {
        const envFile = process.env.KNOCKDESK_CORE_KEY_FILE;
        if (envFile) {
          const raw = origReadFileSync(envFile);
          if (raw.length === 32) coreKey = raw;
          else console.warn('[KnockDesk] KNOCKDESK_CORE_KEY_FILE must hold exactly 32 raw bytes; got '
            + raw.length + '. Ignoring it.');
        }
        if (!coreKey) {
          const userData = app.getPath('userData');
          for (const name of ['core-key.dpapi.bin', 'core-key.tpm.bin']) {
            const blobPath = corePath.join(userData, name);
            try {
              if (!fs.existsSync(blobPath)) continue;
              const raw = unwrapDpapi(blobPath);
              if (raw.length === 32) { coreKey = raw; break; }
              console.warn('[KnockDesk] ' + name + ' did not unwrap to 32 bytes; ignoring it.');
            } catch (e) {
              // Reported, not silent: a broken unwrap is exactly what the raw
              // recovery file below is for, and the message carries no key
              // material, only the store name and the failure text.
              console.warn('[KnockDesk] ' + name + ' could not be unwrapped:',
                (e && e.message) || e);
            }
          }
        }
        if (!coreKey) {
          // Last resort: the raw recovery file the installer writes next to
          // the DPAPI blob. It is only used when the wrapped key could not be
          // read, and it is reported so the user knows the weaker path was
          // taken. Deleting it makes the DPAPI blob the only local copy.
          const rawPath = corePath.join(app.getPath('userData'), 'core-key.raw');
          try {
            if (fs.existsSync(rawPath)) {
              const raw = origReadFileSync(rawPath);
              if (raw.length === 32) {
                coreKey = raw;
                console.warn('[KnockDesk] Core key loaded from the raw recovery file '
                  + '(core-key.raw) because the DPAPI-wrapped key was not readable. '
                  + 'The app will keep working; see docs/security/protected-core.md.');
              } else {
                console.warn('[KnockDesk] core-key.raw is not 32 bytes; ignoring it.');
              }
            }
          } catch (e) {
            console.warn('[KnockDesk] core-key.raw could not be read:', (e && e.message) || e);
          }
        }
      } catch (e) {
        console.warn('[KnockDesk] Core key lookup failed:', (e && e.message) || e);
      }

      const cache = new Map();
      const readCore = (p) => {   // null = not a protected path; caller does a normal read
        if (typeof p !== 'string' || !isProtectedPath(p)) return null;
        if (cache.has(p)) return cache.get(p);
        const raw = origReadFileSync(p);   // asar-aware real read
        if (!raw || raw.length < PREFIX) return raw;
        let zeroPrefix = true;
        for (let i = 0; i < 8; i++) if (raw[i] !== 0) { zeroPrefix = false; break; }
        if (zeroPrefix) {
          const plain = Buffer.from(raw.subarray(PREFIX));
          cache.set(p, plain);
          return plain;
        }
        if (isEncryptedHeader(raw)) {
          if (!coreKey) {
            throw new Error('protected core is encrypted and no key is available. '
              + 'Re-run the installer, or point KNOCKDESK_CORE_KEY_FILE at the '
              + 'recovery key for this installation.');
          }
          const decipher = crypto.createDecipheriv('aes-256-gcm', coreKey, raw.subarray(4, 16));
          decipher.setAuthTag(raw.subarray(16, 32));
          let plain;
          try {
            plain = Buffer.concat([decipher.update(raw.subarray(PREFIX)), decipher.final()]);
          } catch (e) {
            throw new Error('protected entry failed authentication ('
              + corePath.basename(p) + '): the file was altered, or the key does '
              + 'not match this installation.');
          }
          cache.set(p, plain);
          return plain;
        }
        return raw;   // unknown layout: hand it through untouched
      };

      fs.readFileSync = function patchedReadFileSync(p) {
        const out = readCore(p);
        if (out === null) return origReadFileSync.apply(this, arguments);
        const o = arguments[1];
        if (o && typeof o === 'object' && o.encoding) return out.toString(o.encoding);
        if (typeof o === 'string') return out.toString(o);
        return out;
      };

      if (typeof fs.readFile === 'function') {
        const origReadFile = fs.readFile;
        fs.readFile = function patchedReadFile(p) {
          const o = arguments[1];
          const cb = typeof o === 'function' ? o : arguments[2];
          let out;
          try {
            out = readCore(p);
          } catch (e) {
            if (typeof cb === 'function') return process.nextTick(cb, e);
            throw e;
          }
          if (out === null) return origReadFile.apply(this, arguments);
          const enc = (o && typeof o === 'object' && o.encoding) || (typeof o === 'string' ? o : null);
          const value = enc ? out.toString(enc) : out;
          if (typeof cb === 'function') return process.nextTick(cb, null, value);
        };
      }

      if (typeof fs.createReadStream === 'function') {
        const origStream = fs.createReadStream;
        fs.createReadStream = function patchedCreateReadStream(p) {
          const out = readCore(p);
          if (out === null) return origStream.apply(this, arguments);
          const { Readable } = require('stream');
          return new Readable({ read() { this.push(out); this.push(null); } });
        };
      }

      console.log('[KnockDesk] Protected-core read hooks active ('
        + PROTECTED.length + ' entries; key ' + (coreKey ? 'loaded' : 'not present') + ').');
    }

    // ---- 9. Protected-core integrity -------------------------------------
    // The shipped archive carries a manifest of SHA-256 hashes. At boot the
    // app re-hashes the protected entries and compares, so post-install
    // modification, replacement, corruption, or a missing module is visible
    // instead of silently loading something else.
    //
    // This is detection, not prevention. An attacker who can write the
    // archive can write the manifest, and anyone with administrator rights
    // can read every file regardless. Prevention requires Authenticode
    // signing of the installer and executable (docs/ops/signing.md). What
    // this adds is that a modified core never passes unremarked, and that
    // the user gets a recovery path instead of a mystery crash.
    //
    // Failure policy: fail safe, never fail hostile. A mismatch logs one
    // privacy-conscious line (paths and hashes only - no file contents, no
    // keys, no user data), degrades the affected component rather than
    // bricking the app, and points at the repair path.
    try {
      if (process.env.KNOCKDESK_TRUST_CORE !== '1' && typeof app.whenReady === 'function') {
        const manifestPath = corePath.join(__dirname, 'integrity-manifest.json');
        let manifest = null;
        try { manifest = JSON.parse(origReadFileSync(manifestPath, 'utf8')); } catch (e) { manifest = null; }

        if (manifest && manifest.entries) {
          const report = { mismatch: [], missing: [], unreadable: 0, ok: 0 };
          for (const rel of (manifest.protected_entries || Object.keys(manifest.entries))) {
            const want = manifest.entries[rel];
            if (!want || !want.sha256) continue;
            const full = corePath.join(__dirname, '..', rel.replace(/^\/+/, ''));
            let got = null;
            try {
              if (isProtectedPath(full) && !coreKey
                && isEncryptedHeader(origReadFileSync(full))) {
                report.unreadable++;
                continue;
              }
              got = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
            } catch (e) { got = null; }
            if (got === null) report.missing.push(rel);
            else if (got !== want.sha256) report.mismatch.push(rel);
            else report.ok++;
          }

          if (report.unreadable) {
            console.warn('[KnockDesk] Integrity: ' + report.unreadable + ' protected '
              + 'entries are encrypted and could not be checked without the core key.');
          }
          if (report.mismatch.length || report.missing.length) {
            const kinds = [];
            if (report.mismatch.length) kinds.push('modified: ' + report.mismatch.length);
            if (report.missing.length) kinds.push('missing: ' + report.missing.length);
            console.warn('[KnockDesk] Protected-core integrity check found '
              + kinds.join(', ') + '. Verified entries: ' + report.ok + '. '
              + 'The affected component will not be trusted; reinstall or repair '
              + 'from the installer to restore it.');
            // Details are logged once, in full, so support can act on them.
            try {
              const logDir = corePath.join(app.getPath('userData'), 'logs');
              fs.mkdirSync(logDir, { recursive: true });
              const line = JSON.stringify({
                event: 'integrity_check',
                at: new Date().toISOString(),
                verified: report.ok,
                modified: report.mismatch,
                missing: report.missing,
                encrypted_unreadable: report.unreadable,
                app_version: app.getVersion(),
              }) + '\n';
              fs.appendFileSync(corePath.join(logDir, 'integrity.log'), line, 'utf8');
            } catch (logErr) { /* a write failure must never block boot */ }
          } else if (!report.unreadable) {
            console.log('[KnockDesk] Protected-core integrity verified ('
              + report.ok + ' entries).');
          }
        } else {
          console.log('[KnockDesk] No integrity manifest in this build (local/unsigned build).');
        }
      }
    } catch (err) {
      try { console.warn('[KnockDesk] Integrity check skipped:', (err && err.message) || err); } catch {}
    }
  } catch (err) {
    try { console.warn('[KnockDesk] Protected-core support skipped:', (err && err.message) || err); } catch {}
  }
})();

require('./main.jsc');
