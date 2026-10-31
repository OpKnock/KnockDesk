// ═══════════════════════════════════════════════════════════════
//  KnockDesk Computer runtime — kaunsa Python, kaunsa Tesseract
//
//  Sidecar (knockdesk-computer/runner.py) ko ek Python chahiye jis mein
//  gui-agents + pyautogui installed hon, aur OCR ke liye tesseract.exe.
//
//  Packaged app:  resources/computer-runtime/venv   (scripts/setup-computer-runtime.js)
//                 resources/computer-runtime/tesseract/tesseract.exe
//  Dev machine:   wahi folder repo ke andar ho to wahi; warna OpKnock ke lab ka
//                 venv (../agent-s-lab/.venv) aur system ka Tesseract — taake
//                 runtime banaye baghair test ho sake.
//
//  venv hermes-runtime ke CPython par bana hai. Uska pyvenv.cfg bhi wahi
//  masla rakhta hai jo Hermes ka — `home` absolute path hai — is liye pehli
//  dafa chalne par usay theek karna parta hai (hermes-runtime.js jaisa).
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { findRuntimeRoot: findHermesRuntimeRoot } = require('./hermes-runtime');

const isWindows = process.platform === 'win32';
const REPO_ROOT = path.join(__dirname, '..', '..');

function candidates(list) {
    for (const p of list) {
        try {
            if (p && fs.existsSync(p)) return p;
        } catch { /* agla */ }
    }
    return null;
}

/** Bundled computer-runtime ka root (ya null). */
function findComputerRuntimeRoot() {
    return candidates([
        process.resourcesPath ? path.join(process.resourcesPath, 'computer-runtime') : null,
        path.join(REPO_ROOT, 'computer-runtime'),
    ]);
}

/** pyvenv.cfg ka `home` hermes-runtime ke python par lagana. */
function ensureRelocated(root) {
    const cfgPath = path.join(root, 'venv', 'pyvenv.cfg');
    const hermesRoot = findHermesRuntimeRoot();
    if (!hermesRoot) return false;
    const pythonDir = path.join(hermesRoot, 'python');
    let cfg;
    try { cfg = fs.readFileSync(cfgPath, 'utf8'); } catch { return false; }
    const current = /^home\s*=\s*(.*)$/m.exec(cfg);
    if (current && path.resolve(current[1].trim()) === path.resolve(pythonDir)) return true;
    try {
        fs.writeFileSync(cfgPath, cfg.replace(/^home\s*=\s*.*$/m, `home = ${pythonDir}`), 'ascii');
        console.log('[Computer Runtime] pyvenv.cfg home →', pythonDir);
        return true;
    } catch (err) {
        console.error('[Computer Runtime] pyvenv.cfg likhi nahi ja saki:', err.message);
        return false;
    }
}

/**
 * Dev fallback ke liye lab ka venv.
 *
 * Lab folder KnockDesk repo ke ANDAR nahi hota — wo Desktop par apni jagah para
 * hai (`Desktop/agent-s-lab`, jabke repo `Desktop/KnockDesk Ai - AGI/KnockDeskAi_main`).
 * Is liye do level upar tak dekhna parta hai. Ek hi level dekhne se dev mein
 * hamesha "runtime not installed" milta tha — halanke venv mojood tha.
 */
function labVenvCandidates() {
    const names = isWindows
        ? [path.join('.venv', 'Scripts', 'python.exe')]
        : [path.join('.venv', 'bin', 'python')];
    const roots = [
        path.join(REPO_ROOT, '..', '..', 'agent-s-lab'),   // Desktop/agent-s-lab  ← asal jagah
        path.join(REPO_ROOT, '..', 'agent-s-lab'),         // repo ke andar rakha ho to
        path.join(REPO_ROOT, 'agent-s-lab'),
    ];
    const out = [];
    for (const root of roots) for (const name of names) out.push(path.join(root, name));
    return out;
}

/** Python jo sidecar chalayega, ya null. */
function resolvePython() {
    if (process.env.KNOCKDESK_COMPUTER_PYTHON && fs.existsSync(process.env.KNOCKDESK_COMPUTER_PYTHON)) {
        return process.env.KNOCKDESK_COMPUTER_PYTHON;
    }
    if (process.env.STONIC_COMPUTER_PYTHON && fs.existsSync(process.env.STONIC_COMPUTER_PYTHON)) {
        return process.env.STONIC_COMPUTER_PYTHON;
    }
    const root = findComputerRuntimeRoot();
    if (root) {
        const exe = path.join(root, 'venv', isWindows ? 'Scripts' : 'bin', isWindows ? 'python.exe' : 'python');
        if (fs.existsSync(exe) && ensureRelocated(root)) return exe;
    }
    return candidates(labVenvCandidates());
}

/** tesseract.exe ka rasta, ya null (OCR ke baghair bhi agent chalta hai). */
function resolveTesseract() {
    if (process.env.KNOCKDESK_COMPUTER_TESSERACT && fs.existsSync(process.env.KNOCKDESK_COMPUTER_TESSERACT)) {
        return process.env.KNOCKDESK_COMPUTER_TESSERACT;
    }
    if (process.env.STONIC_COMPUTER_TESSERACT && fs.existsSync(process.env.STONIC_COMPUTER_TESSERACT)) {
        return process.env.STONIC_COMPUTER_TESSERACT;
    }
    const root = findComputerRuntimeRoot();
    return candidates([
        root ? path.join(root, 'tesseract', isWindows ? 'tesseract.exe' : 'tesseract') : null,
        isWindows ? 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe' : '/usr/local/bin/tesseract',
        isWindows ? null : '/opt/homebrew/bin/tesseract',
    ]);
}

/** runner.py — packaged mein resources ke andar, dev mein repo mein. */
function resolveRunnerScript() {
    return candidates([
    process.resourcesPath ? path.join(process.resourcesPath, 'knockdesk-computer', 'runner.py') : null,
    path.join(REPO_ROOT, 'knockdesk-computer', 'runner.py'),
    ]);
}

/**
 * Kya kya mila aur kya nahi — insaan ke parhne ke liye.
 *
 * "runtime not installed" apne aap mein bekar paigham hai: kuch nahi batata ke
 * KYA nahi mila. Ye function har us jagah ka naam leta hai jahan dekha gaya,
 * taake ghalti pehli hi nazar mein pakri jaye (dev mein console par, aur tool
 * ke jawab mein bhi).
 */
function describeRuntime() {
    const python = resolvePython();
    const runner = resolveRunnerScript();
    const missing = [];
    if (!python) {
        missing.push(
            'Python (computer-runtime): na bundled venv mila, na lab ka. '
            + 'Chalayein `npm run build:computer-runtime`, ya KNOCKDESK_COMPUTER_PYTHON set karein. '
            + `Dekha gaya: ${labVenvCandidates().join(' | ')}`,
        );
    }
    if (!runner) missing.push('runner.py: knockdesk-computer/runner.py nahi mili.');
    return { ok: missing.length === 0, python, runner, tesseract: resolveTesseract(), missing };
}

/**
 * Windows ka system cursor user ki apni scheme par wapas laana.
 *
 * Sidecar (knockdesk_overlay.py) task ke dauran arrow/hand/I-beam ko "agent
 * cursor" se badal deta hai aur khatam par khud wapas karta hai. Ye backstop
 * sirf us waqt ke liye hai jab sidecar ko zabardasti maara gaya ho aur uska
 * cleanup na chal saka ho. SPI_SETCURSORS registry se scheme dobara load
 * karta hai — idempotent, aur user ki apni custom scheme bhi theek wapas aati
 * hai. Detached is liye ke app quit ke dauran bhi poora ho jaye.
 *
 * Lautata hai: true agar restore shuru hua (Windows + Python mila).
 */
function restoreSystemCursors() {
    if (process.platform !== 'win32') return false;
    const python = resolvePython();
    if (!python) return false;
    try {
        const { spawn } = require('child_process');
        const child = spawn(
            python,
            ['-c', 'import ctypes; ctypes.windll.user32.SystemParametersInfoW(0x57, 0, None, 0)'],
            { detached: true, stdio: 'ignore', windowsHide: true },
        );
        child.on('error', () => { /* backstop hai — chup */ });
        child.unref();
        return true;
    } catch {
        return false;
    }
}

/**
 * Poora process TREE maaro — sirf wo pid nahi jo hum ne spawn kiya.
 *
 * Ye ehtiyat nahi, zaroorat hai: `venv\Scripts\python.exe` (uv trampoline)
 * KHUD interpreter nahi hai — wo `hermes-runtime\python\python.exe` ko CHILD
 * bana kar chalata hai. Yani har sidecar/overlay do PID hota hai, aur Node ka
 * `child.kill()` sirf UPAR wale (trampoline) ko maarta hai. Asli Python —
 * jis ke paas mouse, keyboard aur agent hai — zinda bach jata aur app band
 * hone ke baad bhi background mein chalta rehta.
 *
 * `sync: true` sirf app ke band hone ke raaste par: wahan async kill kabhi
 * chalta hi nahi, app pehle nikal jati hai.
 */
function killProcessTree(pid, { sync = false } = {}) {
    if (!pid) return false;
    try {
        if (isWindows) {
            const { execFileSync, spawn } = require('child_process');
            const args = ['/PID', String(pid), '/T', '/F'];
            if (sync) execFileSync('taskkill', args, { stdio: 'ignore', timeout: 5000, windowsHide: true });
            else spawn('taskkill', args, { stdio: 'ignore', windowsHide: true }).on('error', () => { /* ja chuka */ });
        } else {
            // POSIX: process group (spawn detached na ho to fallback akela pid).
            try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
        }
        return true;
    } catch {
        return false;   // pehle hi mar chuka — yehi aam soorat hai
    }
}

module.exports = {
    resolvePython,
    resolveTesseract,
    resolveRunnerScript,
    findComputerRuntimeRoot,
    describeRuntime,
    restoreSystemCursors,
    killProcessTree,
};
