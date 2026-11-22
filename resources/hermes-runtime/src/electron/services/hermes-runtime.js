// ═══════════════════════════════════════════════════════════════
//  Bundled Hermes Runtime
//
//  The installer ships a self-contained Hermes Agent (see
//  scripts/setup-hermes-runtime.js) so the user never has to install Python
//  or Hermes themselves:
//
//    resources/hermes-runtime/
//      python/                 ← CPython 3.11 (the base interpreter)
//      src/                    ← Hermes' own source tree (skills, whatsapp-bridge…)
//      venv/Scripts/hermes.exe ← relocatable launcher, what we spawn
//      venv/pyvenv.cfg         ← `home = <absolute path to python/>`
//
//  Hermes is installed EDITABLE against src/, the way its own installers do it,
//  because it resolves skills/ and scripts/whatsapp-bridge/ relative to its own
//  code (`PROJECT_ROOT = Path(__file__).parent.parent`). A non-editable install
//  puts that code in site-packages and those directories silently vanish.
//  site-packages/_hermes_src.pth points at src/ with a RELATIVE path, so the
//  import hook needs no rewrite when the app moves.
//
//  `uv venv --relocatable` makes the launcher find its interpreter relative to
//  itself, so hermes.exe survives being installed to an arbitrary directory.
//  What does NOT survive is `pyvenv.cfg`'s `home` key: CPython reads it to
//  locate the stdlib, and it is an absolute path baked in at build time. On a
//  customer's machine that path does not exist and every hermes invocation
//  dies with "No Python at '...'".
//
//  So on first boot we rewrite that one line to wherever the app actually
//  landed. NSIS installs per-user (`perMachine: false`), so resources/ is
//  writable. Idempotent: after the first rewrite the value already matches.
//
//  This module never touches HERMES_HOME (%LOCALAPPDATA%\hermes) — the user's
//  Hermes config, API keys, memories and sessions are their data, and the
//  bundled runtime reads them exactly like a hand-installed Hermes would.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');

const isWindows = process.platform === 'win32';

let cachedExe;          // string | null, resolved once
let relocationDone = false;

/** Root of the shipped runtime tree, or null when it wasn't bundled. */
function findRuntimeRoot() {
    const candidates = [
        process.resourcesPath ? path.join(process.resourcesPath, 'hermes-runtime') : null,
        path.resolve(__dirname, '..', '..', 'resources', 'hermes-runtime'),
        path.resolve(__dirname, '..', '..', '..', '..', 'hermes-runtime'),
        path.join(__dirname, '..', '..', 'hermes-runtime'),
    ];
    for (const dir of candidates) {
        try {
            if (dir && fs.existsSync(path.join(dir, 'venv'))) return dir;
        } catch { /* unreadable — try the next candidate */ }
    }
    return null;
}

function venvBinDir(root) {
    return path.join(root, 'venv', isWindows ? 'Scripts' : 'bin');
}

function bundledHermesExe(root) {
    return path.join(venvBinDir(root), isWindows ? 'hermes.exe' : 'hermes');
}

/**
 * Point `pyvenv.cfg`'s `home` at the interpreter's real location.
 * Returns true when the venv is usable, false when it can't be fixed.
 */
function ensureRelocated(root) {
    const cfgPath = path.join(root, 'venv', 'pyvenv.cfg');
    const pythonDir = path.join(root, 'python');

    let cfg;
    try {
        cfg = fs.readFileSync(cfgPath, 'utf8');
    } catch (err) {
        console.error('[Hermes Runtime] Cannot read pyvenv.cfg:', err.message);
        return false;
    }

    const current = /^home\s*=\s*(.*)$/m.exec(cfg);
    if (current && path.resolve(current[1].trim()) === path.resolve(pythonDir)) {
        return true; // already correct (dev machine, or a previous boot fixed it)
    }

    if (!current) {
        console.error('[Hermes Runtime] pyvenv.cfg has no home entry.');
        return false;
    }

    const patched = cfg.replace(/^home\s*=\s*.*$/m, `home = ${pythonDir}`);
    try {
        fs.writeFileSync(cfgPath, patched, 'ascii');
        console.log('[Hermes Runtime] Relocated pyvenv.cfg home →', pythonDir);
        return true;
    } catch (err) {
        // A per-machine install into Program Files would land here.
        console.error('[Hermes Runtime] pyvenv.cfg is not writable — bundled Hermes will not start:', err.message);
        return false;
    }
}

/** Absolute path to the bundled hermes launcher, or null if unusable. */
function getBundledHermesExe() {
    if (cachedExe !== undefined) return cachedExe;

    const root = findRuntimeRoot();
    if (!root) {
        cachedExe = null;
        return cachedExe;
    }

    const exe = bundledHermesExe(root);
    if (!fs.existsSync(exe)) {
        console.warn('[Hermes Runtime] Runtime tree present but launcher missing:', exe);
        cachedExe = null;
        return cachedExe;
    }

    if (!relocationDone) {
        relocationDone = true;
        if (!ensureRelocated(root)) {
            cachedExe = null;
            return cachedExe;
        }
    }

    cachedExe = exe;
    return cachedExe;
}

/**
 * The Hermes CLI to spawn. Shared by hermes-manager and agenttown-manager so
 * both always agree on which Hermes is running.
 *
 * Order: explicit override → the Hermes we ship → a hand-installed Hermes →
 * PATH. Shipping ours first is what makes a fresh install work with no setup;
 * developers can set KNOCKDESK_HERMES_EXE (STONIC_HERMES_EXE remains a legacy alias).
 */
function resolveHermesExe() {
    const candidates = [];
    const explicitExe = process.env.KNOCKDESK_HERMES_EXE || process.env.STONIC_HERMES_EXE;
    if (explicitExe) candidates.push(explicitExe);

    const bundled = getBundledHermesExe();
    if (bundled) candidates.push(bundled);

    if (isWindows) {
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        candidates.push(path.join(localAppData, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'));
        candidates.push(path.join(localAppData, 'hermes', 'hermes-agent', '.venv', 'Scripts', 'hermes.exe'));
    } else {
        candidates.push(path.join(os.homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes'));
        candidates.push(path.join(os.homedir(), '.local', 'bin', 'hermes'));
    }

    for (const candidate of candidates) {
        try {
            if (candidate && fs.existsSync(candidate)) return candidate;
        } catch { /* ignore */ }
    }
    return isWindows ? 'hermes.exe' : 'hermes'; // last resort: PATH
}

/**
 * The environment every Hermes process KnockDesk launches should inherit.
 *
 * `HERMES_YOLO_MODE=1` turns off Hermes' dangerous-command approval gate for
 * the whole tree we spawn — the dashboard, the gateway it starts, and the
 * `hermes -z` one-shots. KnockDesk is a single-user desktop app driving Hermes on
 * the user's behalf: in the chat panel the prompt only ever interrupted the
 * user's own request, and on WhatsApp there is nobody at the keyboard to
 * answer it, so the turn just blocked until it timed out.
 *
 * Hermes freezes this flag at import time (tools/approval.py `_YOLO_MODE_FROZEN`)
 * precisely so a skill cannot set it mid-run — which is why it has to be handed
 * over at spawn time and cannot be toggled afterwards.
 *
 * This is a bypass, not a disable. Hermes' hardline blocklist (`rm -rf /`,
 * mkfs, dd onto a raw device, shutdown/reboot, fork bomb) and its sudo-stdin
 * guard are checked ABOVE the yolo branch and still block unconditionally.
 *
 * An env var only reaches processes we start ourselves, so HermesManager also
 * persists `approvals.mode: off` once the dashboard answers — see
 * `_ensureApprovalBypass()`.
 */
function hermesSpawnEnv(extra = {}) {
    const env = { ...process.env, ...extra };
    const explicitOptIn =
        process.env.KNOCKDESK_ALLOW_UNAPPROVED_COMMANDS === '1' ||
        extra.KNOCKDESK_ALLOW_UNAPPROVED_COMMANDS === '1';

    // Keep Hermes' approval gate enabled by default. Unattended command
    // execution is an explicit per-launch opt-in, never an implicit app default.
    delete env.KNOCKDESK_ALLOW_UNAPPROVED_COMMANDS;
    if (explicitOptIn) {
        env.HERMES_YOLO_MODE = '1';
    } else {
        delete env.HERMES_YOLO_MODE;
    }

    // Local Gemini key (Settings → AI Engine) bhi gateway tak pohanchao.
    // Gateway ke andar TTS (edge 403 par Gemini fallback) aur kuch agent-side
    // tools isay env se parhte hain; app isay secret_key.json mein rakhti hai.
    if (!env.GEMINI_API_KEY && !env.GOOGLE_API_KEY) {
        try {
            const { app } = require('electron');
            const keyStore = require('./key-store');
            const stored = keyStore.readKey(
                path.join(app.getPath('userData'), 'secret_key.json'),
                ['geminiKey', 'apiKey'],
            );
            if (stored && stored.saved && stored.value) {
                env.GEMINI_API_KEY = String(stored.value).trim();
            }
        } catch { /* key na ho to chup-chaap chhodo — tools apna error khud dete hain */ }
    }
    return env;
}

module.exports = { resolveHermesExe, getBundledHermesExe, findRuntimeRoot, ensureRelocated, hermesSpawnEnv };
