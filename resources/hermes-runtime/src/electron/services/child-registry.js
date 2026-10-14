// ═══════════════════════════════════════════════════════════════
//  Owned-process registry
//
//  Some processes KnockDesk causes to exist are NOT its process-tree children,
//  so `taskkill /T` on our own pids never reaches them:
//
//    KnockDesk → hermes dashboard → (REST /api/gateway/start) → gateway  → whatsapp bridge
//                                 ^ independent process ────┘
//
//  The gateway is started by the dashboard as a sibling, and it spawns the
//  WhatsApp bridge. When KnockDesk exits — and especially when it is hard-killed
//  (Ctrl+C in dev, crash, Task Manager, OS logoff) — those two get re-parented
//  to init/services and keep running, holding port 3010 and answering WhatsApp
//  long after the app is gone. That is the orphan users see as "Hermes is still
//  running even though KnockDesk is closed".
//
//  This module records such processes on disk so the NEXT launch can finish the
//  cleanup that the crashed run never got to do.
//
//  Two rules keep it from ever killing a Hermes the user started themselves:
//
//    1. Delta only. The caller snapshots the matching processes BEFORE asking
//       Hermes to start a gateway; only pids that appear afterwards are recorded
//       as ours. A dashboard/gateway the user launched by hand is in the
//       snapshot and is therefore never owned.
//    2. pid + creation time. A pid alone is not identity — Windows recycles
//       them fast, and killing a recycled pid on the next launch would take out
//       an unrelated process. Every entry carries the process creation
//       timestamp and is re-verified against the live process before any kill.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const isWindows = process.platform === 'win32';
const FILE_NAME = 'knockdesk-owned-processes.json';
const LEGACY_FILE_NAME = 'knockdesk-owned-processes.json';

// Names worth inspecting. Filtering by name first is not just an optimization:
// our own discovery command line contains the patterns below, so an unfiltered
// scan matches the powershell.exe that is running the scan.
const PROC_NAMES = ['node.exe', 'python.exe', 'pythonw.exe', 'hermes.exe'];
// A Hermes gateway (`-m hermes_cli.main gateway run`) or the WhatsApp bridge it
// spawns (`scripts/whatsapp-bridge/bridge.js`).
const CMD_PATTERNS = ['hermes_cli', 'whatsapp-bridge'];

let registryPath = null;

/** Where the registry lives. Set once from main.js after `app.whenReady()`. */
function setRegistryDir(dir) {
  registryPath = path.join(dir, FILE_NAME);
  // One-time rebrand migration: carry the owned-process registry across.
  try {
    const legacy = path.join(dir, LEGACY_FILE_NAME);
    if (!fs.existsSync(registryPath) && fs.existsSync(legacy)) fs.renameSync(legacy, registryPath);
  } catch { /* registry rebuilds itself; never fail boot for it */ }
}

function readRegistry() {
  if (!registryPath) return { entries: [] };
  try {
    const raw = fs.readFileSync(registryPath, 'utf8');
    const parsed = JSON.parse(raw);
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] }; // absent or corrupt — a clean slate is the safe read
  }
}

function writeRegistry(entries) {
  if (!registryPath) return;
  try {
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString(), entries }, null, 2),
      'utf8'
    );
  } catch (err) {
    console.warn('[ChildRegistry] Could not write registry:', err.message);
  }
}

function clearRegistry() {
  if (!registryPath) return;
  try { fs.rmSync(registryPath, { force: true }); } catch { /* already gone */ }
}

function runPowerShell(script, timeoutMs = 15000) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: timeoutMs }
  );
}

/**
 * Every live Hermes gateway / WhatsApp bridge process on the machine, as
 * `{ pid, createdAt }`. Identity is the pair, never the pid alone.
 */
function discoverHermesProcesses() {
  try {
    if (isWindows) {
      const nameFilter = PROC_NAMES.map((n) => `Name='${n}'`).join(' OR ');
      const cmdFilter = CMD_PATTERNS.map((p) => `$_.CommandLine -like '*${p}*'`).join(' -or ');
      const out = runPowerShell(
        `Get-CimInstance Win32_Process -Filter "${nameFilter}" | ` +
        `Where-Object { $_.CommandLine -and (${cmdFilter}) } | ` +
        "ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.CreationDate.ToString('o') }"
      );
      return out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [pid, createdAt] = line.split('|');
          return { pid: Number(pid), createdAt: String(createdAt || '') };
        })
        .filter((e) => Number.isInteger(e.pid) && e.pid > 0 && e.createdAt);
    }
    // POSIX: `lstart` is a fixed 5-field timestamp ("Sun Jul 20 10:08:39 2026").
    const out = execFileSync('ps', ['-eo', 'pid=,lstart=,command='], {
      encoding: 'utf8', timeout: 15000,
    });
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => CMD_PATTERNS.some((p) => line.includes(p)))
      .map((line) => {
        const parts = line.split(/\s+/);
        const pid = Number(parts[0]);
        const createdAt = parts.slice(1, 6).join(' ');
        return { pid, createdAt };
      })
      .filter((e) => Number.isInteger(e.pid) && e.pid > 0 && e.createdAt);
  } catch (err) {
    // `ps` exits non-zero on no match; on Windows a timeout lands here too.
    console.warn('[ChildRegistry] Hermes process discovery failed:', err.message);
    return [];
  }
}

const key = (e) => `${e.pid}|${e.createdAt}`;

/**
 * Record every process matching the Hermes patterns that did NOT exist in
 * `snapshot` — i.e. the ones our gateway start is responsible for. Additive:
 * the bridge appears seconds after the gateway, so this is safe to call
 * repeatedly as state refreshes.
 */
function reconcileOwned(snapshot) {
  const preexisting = new Set((snapshot || []).map(key));
  const owned = discoverHermesProcesses().filter((e) => !preexisting.has(key(e)));
  const merged = new Map();
  for (const e of readRegistry().entries) merged.set(key(e), e);
  for (const e of owned) merged.set(key(e), e);
  const entries = [...merged.values()];
  if (entries.length) writeRegistry(entries);
  return entries;
}

/**
 * Force-kill every recorded process that is still alive AND still the same
 * process we recorded (pid + creation time must both match). Synchronous, so it
 * is usable from `before-quit`/`will-quit` where async work never completes.
 * Returns how many were stopped.
 *
 * `timeoutMs` caps the PowerShell call. It matters on the quit path: this blocks
 * the main thread, and until it returns the process is still alive holding the
 * single-instance lock, which is what makes a relaunch in that window fail.
 */
function killOwnedSync({ timeoutMs } = {}) {
  const { entries } = readRegistry();
  if (!entries.length) { clearRegistry(); return 0; }
  let stopped = 0;
  try {
    if (isWindows) {
      // Build a pid → expected-creation-time map so a recycled pid is skipped.
      const pairs = entries
        .map((e) => `'${e.pid}'='${e.createdAt.replace(/'/g, "''")}'`)
        .join('; ');
      const filter = entries.map((e) => `ProcessId=${e.pid}`).join(' OR ');
      const out = runPowerShell(
        `$want = @{ ${pairs} }; ` +
        `Get-CimInstance Win32_Process -Filter "${filter}" -ErrorAction SilentlyContinue | ` +
        "ForEach-Object { if ($want[[string]$_.ProcessId] -eq $_.CreationDate.ToString('o')) { " +
        'Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId } }',
        timeoutMs
      );
      stopped = out.trim().split(/\r?\n/).filter(Boolean).length;
    } else {
      const live = new Set(discoverHermesProcesses().map(key));
      for (const e of entries) {
        if (!live.has(key(e))) continue; // gone, or a recycled pid — leave it be
        try { process.kill(e.pid, 'SIGKILL'); stopped++; } catch { /* already gone */ }
      }
    }
  } catch (err) {
    console.warn('[ChildRegistry] Owned-process sweep could not complete:', err.message);
  }
  clearRegistry();
  if (stopped) console.log(`[ChildRegistry] Stopped ${stopped} owned Hermes process(es).`);
  return stopped;
}

/**
 * Startup sweep: anything still recorded belongs to a previous run that never
 * cleaned up (crash, Ctrl+C, Task Manager, logoff). Kill it before we start our
 * own, so the new run does not fight an orphan for port 3010 / 9119.
 */
function sweepPreviousRunSync() {
  const { entries } = readRegistry();
  if (!entries.length) return 0;
  console.log(`[ChildRegistry] Found ${entries.length} process(es) left by a previous run — sweeping.`);
  return killOwnedSync();
}

module.exports = {
  setRegistryDir,
  discoverHermesProcesses,
  reconcileOwned,
  killOwnedSync,
  sweepPreviousRunSync,
  clearRegistry,
};
