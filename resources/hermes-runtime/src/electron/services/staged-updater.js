'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  STAGED UPDATER (Windows) — the update is finished BEFORE the restart
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT WAS WRONG
 * --------------
 * The NSIS path downloads KnockDesk-AI-Setup-<v>.exe — a sealed 622MB box — and
 * calls that "downloaded". Everything expensive then happens AFTER the user
 * clicks Restart, with the app closed and a Setup window on screen:
 *
 *     app-64.7z out of the exe into %TEMP%     ~600 MB written
 *     Nsis7z::Extract into %TEMP%\7z-out       ~2.0 GB written
 *     CopyFiles %TEMP%\7z-out → install dir    ~2.0 GB read + written
 *
 * ~4.6GB of disk work, all of it inside the user's wait. That is the "it
 * installs itself all over again" report, and no amount of wording fixes it:
 * the work really is happening then.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * The same work, moved to where nobody is waiting for it — while the app is
 * still running and the user is still using it:
 *
 *     1. Ask <feed>/staged/latest.json what the newest version is.
 *     2. Fetch its manifest: every file's path, size and SHA-256.
 *     3. Compare against what is installed. Files whose hash already matches
 *        are NOT downloaded — they are hard-linked, which costs no bytes and
 *        no disk space (see HARD LINKS below). Only genuinely changed files
 *        are fetched, each as its own content-addressed blob.
 *     4. Build the complete next version in "<install dir>.staging".
 *     5. Verify EVERY file in that tree against the manifest by hash.
 *     6. Only then tell the renderer 'downloaded' — only then does the user
 *        ever see a Restart button.
 *
 * On Restart the app tears its children down (unchanged — the existing
 * teardownBeforeUpdateInstall) and hands two renames to a helper that runs
 * from outside the installation, so it is not standing inside the folder it is
 * moving:
 *
 *     "KnockDesk AI"          →  "KnockDesk AI.old-<stamp>"
 *     "KnockDesk AI.staging"  →  "KnockDesk AI"
 *
 * Both are renames within one directory, so NTFS does them as metadata
 * updates: no copying, no size dependency, ~milliseconds. The install path
 * never changes, which is what keeps shortcuts, the uninstaller, the Gen 2
 * guard and the relocated pyvenv.cfg files all valid.
 *
 * HARD LINKS — why staging is nearly free
 * ---------------------------------------
 * A hard link is a second name for bytes already on disk, not a second copy.
 * ~28,000 of KnockDesk's ~28,400 files (python-embedded, hermes-runtime,
 * computer-runtime, browsers/chromium, agent-town) are byte-identical between
 * releases, so staging links them and writes only what actually changed.
 * A staged 2.0GB update typically occupies tens of megabytes.
 * Links require one volume, which is why staging is a SIBLING of the install
 * directory and never %TEMP% (a user who installed to D: would otherwise get
 * a cross-volume copy, and the rename at the end would become a 2.0GB move).
 *
 * SAFETY
 * ------
 *   * HTTPS only, and the version must be strictly newer — never a downgrade.
 *   * Every blob is verified by SHA-256 against the manifest before it is
 *     written, and the finished tree is verified again, file by file, before
 *     the Restart button appears. A tree that fails verification is deleted.
 *   * Manifest paths are rejected unless they stay inside the staging root
 *     (no "..", no absolute paths, no drive letters, no reparse tricks).
 *   * The swap is guarded by a RunOnce entry written BEFORE the first rename
 *     and removed after the last. If the machine loses power mid-swap, the
 *     next logon re-runs the helper in repair mode and puts the install back.
 *   * Anything unexpected — feed down, manifest bad, disk full, a failed
 *     verify, the kill switch in the feed — hands the whole update over to
 *     the proven electron-updater/NSIS path instead of failing the user.
 *
 * The renderer contract is unchanged: same 'update-status' payloads, same
 * 'install-update' / 'check-for-updates' IPC. The UI only gained an optional
 * `phase` field so it can say "Preparing" instead of "Updating".
 */

const { app, ipcMain } = require('electron');
// ── The REAL filesystem, not Electron's ────────────────────────────────────
// Electron replaces `fs` with a version that treats any path ending in .asar as
// an archive to look INSIDE. That is what lets the app require modules out of
// app.asar — and it makes the archive itself unreadable AS A FILE, which is the
// only way this updater ever wants to read it.
//
// Measured inside the real Electron runtime, on resources/app.asar:
//
//     patched  fs.statSync         ->  size 0            (silently wrong)
//     patched  fs.createReadStream ->  ENOENT            (cannot hash it)
//     original fs.statSync         ->  size 368,633,957  (correct)
//     original fs.createReadStream ->  ok
//
// A size of 0 and an unreadable stream on the installation's single largest
// file (352MB) is what made verification declare it broken, re-download it,
// declare it broken again, and fail the whole update at 100% — every time.
// The unit tests could not see it: they run in plain Node, where there is no
// patched fs and no .asar to trip over.
//
// `original-fs` is Electron's own untouched copy of Node's fs, and is what
// electron-builder and electron-updater use for exactly this reason. Outside
// Electron the module does not exist, and plain fs is already the real one.
let fs;
try {
  fs = require('original-fs');
} catch {
  fs = require('fs');
}
const fsp = fs.promises;

// Nothing here needs Electron's patched fs any more. The swap helper used to be
// a script inside app.asar that had to be read out through it; it is now a
// compiled exe shipped as a plain file in resources/ (see materialiseSwapHelper),
// which original-fs reads like any other file.
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

const PREFIX = '[Staged Updater]';

// ── Where the updater's own account of itself goes ──────────────────────────
// console.log in a packaged Windows app goes nowhere: the process is built for
// the windows subsystem, so there is no console attached and nothing keeps the
// output. That is not a small gap for this particular component. When the first
// staged update failed on a real machine, the app was retrying every 60 seconds
// and the reason was written only to a stream nobody could read — the only way
// to find out what it was, was to relaunch the app from a shell with logging
// forced on. A user cannot do that, and neither can we once the app is theirs.
//
// So every line goes to a file as well, next to the rest of the user data.
// Capped and rotated once, because an updater that retries hourly for months
// must not quietly grow a log the size of the app.
const LOG_MAX_BYTES = 1024 * 1024;
let logStream = null;
let logPath = null;

function openLogStream() {
  if (logStream) return logStream;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, 'staged-updater.log');
    // One generation back is enough to cover "what happened the last time it
    // tried"; keeping more would just be a bigger thing to never read.
    try {
      if (fs.statSync(logPath).size > LOG_MAX_BYTES) {
        fs.renameSync(logPath, `${logPath}.1`);
      }
    } catch { /* no log yet, or it cannot be rotated — append anyway */ }
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
    logStream.on('error', () => { logStream = null; });
  } catch {
    logStream = null; // console only
  }
  return logStream;
}

function writeLog(level, parts) {
  const stream = openLogStream();
  if (!stream) return;
  const text = parts
    .map((p) => (p instanceof Error ? (p.stack || p.message) : typeof p === 'object' ? JSON.stringify(p) : String(p)))
    .join(' ');
  try {
    stream.write(`${new Date().toISOString()} ${level} ${text}\n`);
  } catch { /* a broken log must never break an update */ }
}

const log = {
  info: (...a) => { console.log(PREFIX, ...a); writeLog('INFO', a); },
  warn: (...a) => { console.warn(PREFIX, ...a); writeLog('WARN', a); },
  error: (...a) => { console.error(PREFIX, ...a); writeLog('ERROR', a); },
  /** Where the file is, so a support conversation can ask for it by path. */
  path: () => logPath,
};

// ── Tunables ────────────────────────────────────────────────────────────────
const FEED_FILE = 'staged/latest.json';
const DEFAULT_FEED_BASE = 'http://127.0.0.1:1';
const INITIAL_CHECK_DELAY_MS = 8 * 1000;
const NORMAL_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];
const DOWNLOAD_CONCURRENCY = 6;
const INVENTORY_CONCURRENCY = 8;
const BLOB_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const FEED_TIMEOUT_MS = 20 * 1000;
// Staging writes only changed files, but a release that moves a runtime can
// still be large. Refuse to start rather than fill the user's disk.
const FREE_SPACE_HEADROOM_BYTES = 1.5 * 1024 * 1024 * 1024;

// Boot is busy. Deleting the old 2.0GB installation waits until it is not.
const POST_BOOT_SWEEP_DELAY_MS = 45 * 1000;

// One bar for the user, four phases behind it. Each phase owns a slice and the
// slices are consecutive, so the bar cannot move backwards when a phase ends --
// which is exactly what it did while the inventory pass and the linking pass
// both reported into 0-8%.
const PCT_INVENTORY_END = 4;   // hashing the installation (first staged update only)
const PCT_LINK_END = 10;       // reusing files the machine already has
const PCT_DOWNLOAD_END = 82;   // fetching what actually changed
                               // 82-100: verifying the finished tree

// ── Paths ───────────────────────────────────────────────────────────────────
function getInstallDir() {
  return path.dirname(process.execPath);
}
function getStagingDir() {
  const installDir = getInstallDir();
  return path.join(path.dirname(installDir), `${path.basename(installDir)}.staging`);
}
function getCacheDir() {
  const base = process.env.LOCALAPPDATA || app.getPath('userData');
  const next = path.join(base, 'knockdesk-updater', 'staged');
  // One-time rebrand migration: carry the whole update cache across
  // (staged tree + installer.exe), so nothing is re-downloaded.
  try {
    const prevRoot = path.join(base, 'knockdesk_gen3-updater');
    const nextRoot = path.join(base, 'knockdesk-updater');
    if (!fs.existsSync(nextRoot) && fs.existsSync(prevRoot)) fs.renameSync(prevRoot, nextRoot);
  } catch { /* cache rebuilds itself; never fail boot for it */ }
  return next;
}
const cachePath = (name) => path.join(getCacheDir(), name);

// The tree is only trusted when this file says it is, and it is written last.
const READY_MARKER = '.knockdesk-staged.json';
// The one file the installation has that no build has: NSIS writes it at
// install time. Carried across every swap (preserveInstallOnlyFiles), and
// therefore never a stray when a resumed tree already holds it.
const INSTALL_ONLY_FILE = /^Uninstall .*\.exe$/i;

// ── Small helpers ───────────────────────────────────────────────────────────

function getFeedBase() {
  try {
    const cfgPath = path.join(process.resourcesPath, 'app-update.yml');
    if (fs.existsSync(cfgPath)) {
      const m = fs.readFileSync(cfgPath, 'utf8').match(/^url:\s*(\S+)/m);
      if (m) return m[1].replace(/['"]/g, '').replace(/\/+$/, '');
    }
  } catch { /* fall through to the compiled-in default */ }
  return DEFAULT_FEED_BASE;
}

function isNewerVersion(remote, local) {
  const pa = String(remote).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(local).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const a = pa[i] || 0;
    const b = pb[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false; // equal is not newer, and older is a downgrade we refuse
}

/**
 * Turn a manifest path into a path guaranteed to stay inside `root`.
 * Returns null for anything that tries to escape — the manifest arrives over
 * the network, so this is the boundary that keeps a bad one from writing into
 * Windows\System32 or over the user's own files.
 */
function safeJoin(root, relative) {
  if (typeof relative !== 'string' || !relative) return null;
  if (relative.includes('\0')) return null;
  // Absolute, UNC and drive-qualified forms are all rejected outright.
  if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative) || relative.startsWith('\\\\')) return null;
  const normalized = path.normalize(relative);
  if (normalized.split(/[\\/]/).some((seg) => seg === '..')) return null;
  const full = path.resolve(root, normalized);
  const rootWithSep = path.resolve(root) + path.sep;
  if (full !== path.resolve(root) && !full.startsWith(rootWithSep)) return null;
  return full;
}

/**
 * Fetch a small text document. A URL ending in .gz is decompressed on the way
 * in — the manifest for ~28,000 files is 4.7MB of JSON and about 600KB gzipped,
 * and that difference is paid by every user on every release.
 */
function httpGetText(url, timeoutMs = FEED_TIMEOUT_MS, redirects = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'Cache-Control': 'no-cache' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return httpGetText(new URL(res.headers.location, url).toString(), timeoutMs, redirects - 1)
          .then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const source = url.split('?')[0].endsWith('.gz') ? res.pipe(zlib.createGunzip()) : res;
      let data = '';
      let size = 0;
      source.setEncoding('utf8');
      source.on('data', (c) => {
        size += c.length;
        // A manifest for ~28k files is a few MB; anything past this is not ours.
        if (size > 64 * 1024 * 1024) {
          res.destroy();
          source.destroy();
          reject(new Error('Response too large'));
          return;
        }
        data += c;
      });
      source.on('end', () => resolve(data));
      source.on('error', reject);
      if (source !== res) res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timeout')));
  });
}

function httpGetStream(url, timeoutMs = REQUEST_TIMEOUT_MS, redirects = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return httpGetStream(new URL(res.headers.location, url).toString(), timeoutMs, redirects - 1)
          .then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timeout')));
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

// Windows refuses to delete a file that someone else has open without sharing
// delete access, and on a machine with real-time antivirus that someone is
// usually the scanner: every one of the ~28,400 files this updater creates is
// opened and read by Defender moments after it appears. The scan is short, so
// the refusal is short — but "short" is longer than one second on a 2GB tree,
// which is all the previous 5 x 200ms gave it.
//
// Measured on the machine where this first failed: each attempt died on a
// DIFFERENT file (ffmpeg.dll, then chrome_100_percent.pak, then libEGL.dll...),
// and every one of those files deleted without complaint minutes later with the
// app still running and those DLLs still loaded. That is a race, not a lock.
//
// Note what is NOT the reason, because it looks like it should be: a loaded DLL
// does not protect its hard links. Deleting one of two names for a file only
// removes that name; the file itself, and the mapping, survive. This was
// verified directly rather than assumed.
const RM_BACKOFF_MS = [0, 250, 500, 1000, 2000, 4000];
const RM_RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);

async function rimraf(target) {
  let lastError = null;
  for (const wait of RM_BACKOFF_MS) {
    if (wait) await sleep(wait);
    try {
      await fsp.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      return;
    } catch (err) {
      lastError = err;
      // A path that cannot be deleted for a reason waiting will not fix — a bad
      // path, a read-only volume — should fail now rather than in eight seconds.
      if (!RM_RETRYABLE.has(err.code)) throw err;
    }
  }
  throw lastError;
}

/**
 * Clear the staging tree, and never let a stale one block the update.
 *
 * Deleting 28,400 files while a scanner is reading them can lose the race even
 * with the backoff above. That must not be fatal: the tree being cleared is
 * already scrap, and refusing to start because scrap could not be removed is
 * how one failed attempt turned into a machine that could never update again.
 *
 * So when the delete cannot win, the tree is moved aside instead. A rename is a
 * single directory-entry change — it does not touch the files inside, so a
 * scanner holding one of them does not block it — and it is the same move
 * Windows itself makes for in-use files (MOVEFILE_DELAY_UNTIL_REBOOT), that
 * Chrome makes for a running chrome.exe, and that Squirrel makes for an old
 * app-<version> folder. The leftovers are swept after the next boot, where a
 * failure to remove them is also survivable.
 */
async function clearStagingDir(stagingDir) {
  if (!(await pathExists(stagingDir))) return null;
  try {
    await rimraf(stagingDir);
    return null;
  } catch (err) {
    const aside = `${stagingDir}.stale-${Date.now().toString(36)}`;
    await fsp.rename(stagingDir, aside);
    log.warn(
      `Could not delete the previous staged tree (${err.code || err.message}); ` +
      `moved it to ${path.basename(aside)} and carried on. It is swept after the next boot.`
    );
    return aside;
  }
}

async function pathExists(target) {
  try { await fsp.access(target); return true; } catch { return false; }
}

/**
 * 'same' when `a` and `b` are one file under two names (a hard link), 'missing'
 * when `b` does not exist, 'different' otherwise. Identity is the volume plus
 * the file id — what a hard link shares with its source and a copy does not —
 * so a link an earlier attempt made can be recognised with two stats and no
 * reading at all.
 */
async function compareFile(a, b) {
  let sb;
  try { sb = await fsp.stat(b, { bigint: true }); } catch { return 'missing'; }
  try {
    const sa = await fsp.stat(a, { bigint: true });
    return sa.dev === sb.dev && sa.ino === sb.ino && sa.size === sb.size ? 'same' : 'different';
  } catch {
    return 'different';
  }
}

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/**
 * Run `task` over `items` with a fixed number of workers.
 *
 * Hashing is a read-and-compute job, so it is bounded by how many reads the OS
 * will serve at once, not by how fast one read can be issued. One at a time
 * took 29 minutes 39 seconds over the installation's 1.92GB on the machine this
 * was measured on; the release script hashes the same bytes in 36 seconds with
 * eight workers. That difference was the whole of the "why is it so slow".
 */
async function mapConcurrent(items, limit, task) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await task(items[index], index);
    }
  });
  await Promise.all(workers);
}

/** Free bytes on the volume that holds `dir`, or null when it cannot be read. */
function freeSpaceBytes(dir) {
  try {
    const stat = fs.statfsSync(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Manifest handling
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A manifest entry is { p: relative path, h: sha256 hex, s: size in bytes }.
 * Anything malformed makes the whole manifest invalid — a partially understood
 * manifest is the one thing that must never be allowed to drive a swap.
 */
function validateManifest(manifest, expectedVersion) {
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest is not an object');
  if (manifest.schema !== 1) throw new Error(`unsupported manifest schema ${manifest.schema}`);
  if (manifest.version !== expectedVersion) {
    throw new Error(`manifest version ${manifest.version} does not match feed version ${expectedVersion}`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('manifest has no files');
  if (typeof manifest.executable !== 'string' || !manifest.executable) throw new Error('manifest has no executable');

  const seen = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.p !== 'string' || typeof entry.h !== 'string' || typeof entry.s !== 'number') {
      throw new Error('manifest entry is malformed');
    }
    if (!/^[0-9a-f]{64}$/.test(entry.h)) throw new Error(`manifest entry ${entry.p} has a bad hash`);
    if (entry.s < 0 || !Number.isFinite(entry.s)) throw new Error(`manifest entry ${entry.p} has a bad size`);
    if (safeJoin(os.tmpdir(), entry.p) === null) throw new Error(`manifest entry ${entry.p} is not a safe path`);
    const key = entry.p.replace(/\//g, '\\').toLowerCase();
    if (seen.has(key)) throw new Error(`manifest lists ${entry.p} twice`);
    seen.add(key);
  }
  if (!manifest.files.some((e) => e.p.replace(/\//g, '\\').toLowerCase() === manifest.executable.toLowerCase())) {
    throw new Error('manifest does not contain its own executable');
  }
  return manifest;
}

/**
 * What is installed right now, as { relative path → sha256 }.
 *
 * The fast path is the manifest kept from the previous staged update, which is
 * exact and costs nothing. The first time on a machine there is none, so the
 * install directory is hashed once (~2.0GB, a background read) and the result
 * is kept for next time. Either way the answer is only a HINT: every file that
 * gets linked on the strength of it is hashed again during verification.
 */
async function loadInstalledInventory(installDir, onProgress) {
  const files = [];
  const walk = async (dir) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  await walk(installDir);

  // Records from the last time this version was inventoried. A record is only
  // believed while the file's size AND modification time are still what they
  // were: those two numbers cost one stat, and a file the app rewrote since —
  // pyvenv.cfg is the one that really happens — fails the check and is hashed
  // again instead of being trusted.
  const cached = new Map();
  const stored = await readJsonIfPresent(cachePath('installed-manifest.json'));
  if (stored && stored.schema === 2 && stored.version === app.getVersion() && Array.isArray(stored.files)) {
    for (const entry of stored.files) {
      if (entry && typeof entry.p === 'string' && typeof entry.h === 'string') cached.set(entry.p, entry);
    }
  }
  if (cached.size) log.info(`Inventory cache has ${cached.size} file(s) for ${app.getVersion()}.`);
  else log.info('No usable inventory cache for this version — hashing the installation.');

  const map = new Map();
  const records = [];
  let done = 0;
  let rehashed = 0;
  await mapConcurrent(files, INVENTORY_CONCURRENCY, async (full) => {
    try {
      const rel = path.relative(installDir, full).replace(/\//g, '\\').toLowerCase();
      const stat = await fsp.stat(full);
      const prior = cached.get(rel);
      let hash;
      if (prior && prior.s === stat.size && prior.m === stat.mtimeMs) {
        hash = prior.h;
      } else {
        hash = await sha256File(full);
        rehashed += 1;
      }
      // mtimeMs is carried so the settle pass in buildStagingTree can tell
      // "this is the file I linked" from "this file changed while I worked".
      map.set(rel, { hash, size: stat.size, mtimeMs: stat.mtimeMs });
      records.push({ p: rel, h: hash, s: stat.size, m: stat.mtimeMs });
    } catch (err) {
      log.warn(`Could not hash ${full}: ${err.message}`);
    }
    done += 1;
    if (onProgress && done % 500 === 0) onProgress(done, files.length);
  });
  log.info(`Installed inventory: ${map.size} file(s), ${rehashed} hashed now, ${map.size - rehashed} from cache.`);

  // Keep it. The whole reason the cache is read above is so the next attempt
  // does not pay for this again — but nothing ever wrote it, so every single
  // attempt re-hashed 2.0GB and sat at the start of the bar for half an hour
  // while it did. The version is part of the record: after a swap the
  // installation is a different build and the cache is rebuilt, not trusted.
  //
  // A cache that cannot be written is not worth failing an update over.
  try {
    await writeJsonAtomic(cachePath('installed-manifest.json'), {
      schema: 2,
      version: app.getVersion(),
      files: records,
    });
  } catch (err) {
    log.warn(`Could not cache the installed inventory: ${err.message}`);
  }

  return map;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Staging
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Link what we already have, download what we do not, verify all of it.
 * Returns the number of bytes actually pulled over the network.
 */
async function buildStagingTree({ manifest, installDir, stagingDir, blobBase, inventory, report, isCancelled }) {
  const manifestFiles = manifest.files;
  const byKey = new Map();
  for (const entry of manifestFiles) byKey.set(entry.p.replace(/\//g, '\\').toLowerCase(), entry);

  // ── Phase 1: link every file whose hash the installation already has ──────
  const needed = [];
  // Only a HARD LINK shares its metadata with the installed file, so only a hard
  // link can be checked by comparing modification times later. A copy gets its
  // own timestamps and a download is a new file, and both of those had their
  // contents established some other way.
  const hardLinked = new Set();
  let linked = 0;
  let linkIndex = 0;
  for (const entry of manifestFiles) {
    if (isCancelled()) throw new Error('cancelled');
    const dest = safeJoin(stagingDir, entry.p);
    if (!dest) throw new Error(`refusing unsafe manifest path: ${entry.p}`);

    const key = entry.p.replace(/\//g, '\\').toLowerCase();
    const have = inventory.get(key);
    let reused = false;
    if (have && have.hash === entry.h && have.size === entry.s) {
      const source = safeJoin(installDir, entry.p);
      if (source && await pathExists(source)) {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        // An earlier attempt may have linked this already. A hard link IS the
        // installed file, so that is checkable without reading a byte. Anything
        // else at that path is not what this pass would create, and goes.
        const existing = await compareFile(source, dest);
        if (existing === 'same') {
          reused = true;
          hardLinked.add(key);
        } else {
          if (existing === 'different') await rimraf(dest).catch(() => {});
          try {
            await fsp.link(source, dest);
            reused = true;
            hardLinked.add(key);
          } catch (linkErr) {
            // Different volume, a filesystem without links, or a hostile AV.
            // Copying is slower but produces exactly the same tree.
            try {
              await fsp.copyFile(source, dest);
              reused = true;
            } catch (copyErr) {
              log.warn(`Could not reuse ${entry.p} (${linkErr.code || linkErr.message} / ${copyErr.message}); will download.`);
            }
          }
        }
      }
    }
    if (reused) linked += 1;
    else needed.push(entry);

    linkIndex += 1;
    if (linkIndex % 400 === 0) {
      const share = linkIndex / manifestFiles.length;
      report(PCT_INVENTORY_END + Math.round(share * (PCT_LINK_END - PCT_INVENTORY_END)), 'preparing');
    }
  }

  // ── Phase 1b: what an earlier attempt already downloaded ─────────────────
  // A file that is here and hashes to the manifest is a verified file, however
  // it got here. Reading it costs less than fetching it, and on a resumed
  // staging it is most of the download.
  const toFetch = [];
  let resumed = 0;
  await mapConcurrent(needed, INVENTORY_CONCURRENCY, async (entry) => {
    if (isCancelled()) return;
    const dest = safeJoin(stagingDir, entry.p);
    try {
      const stat = await fsp.stat(dest);
      if (stat.size === entry.s && (await sha256File(dest)) === entry.h) {
        resumed += 1;
        return;
      }
    } catch { /* not staged yet */ }
    toFetch.push(entry);
  });
  if (isCancelled()) throw new Error('cancelled');

  const bytesToFetch = toFetch.reduce((sum, e) => sum + e.s, 0);
  log.info(
    `Staging plan: ${linked} file(s) reused from the installation, ` +
    (resumed ? `${resumed} already staged by an earlier attempt, ` : '') +
    `${toFetch.length} to download (${(bytesToFetch / 1048576).toFixed(1)} MB uncompressed).`
  );
  report(PCT_LINK_END, 'preparing');

  // ── Phase 2: download only what changed ──────────────────────────────────
  let fetchedBytes = 0;
  let networkBytes = 0;
  const reportDownload = () => {
    const share = bytesToFetch > 0 ? fetchedBytes / bytesToFetch : 1;
    report(PCT_LINK_END + Math.round(share * (PCT_DOWNLOAD_END - PCT_LINK_END)), 'downloading');
  };

  const fetchOne = async (entry) => {
    const dest = safeJoin(stagingDir, entry.p);
    if (!dest) throw new Error(`refusing unsafe manifest path: ${entry.p}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const url = `${blobBase}${entry.h}.gz`;

    let lastError = null;
    for (let attempt = 1; attempt <= BLOB_RETRIES; attempt += 1) {
      if (isCancelled()) throw new Error('cancelled');
      const tmp = `${dest}.part`;
      try {
        const res = await httpGetStream(url);
        const hash = crypto.createHash('sha256');
        const gunzip = zlib.createGunzip();
        const out = fs.createWriteStream(tmp);
        let written = 0;

        await new Promise((resolve, reject) => {
          const fail = (err) => { res.destroy(); gunzip.destroy(); out.destroy(); reject(err); };
          res.on('data', (chunk) => { networkBytes += chunk.length; });
          res.on('error', fail);
          gunzip.on('error', fail);
          out.on('error', fail);
          gunzip.on('data', (chunk) => {
            hash.update(chunk);
            written += chunk.length;
            if (written > entry.s) fail(new Error('blob is larger than the manifest says'));
          });
          out.on('finish', resolve);
          res.pipe(gunzip).pipe(out);
        });

        const digest = hash.digest('hex');
        if (digest !== entry.h) throw new Error(`hash mismatch (got ${digest.slice(0, 12)}…)`);
        if (written !== entry.s) throw new Error(`size mismatch (${written} vs ${entry.s})`);

        // On the repair pass `dest` already exists — it is the linked file that
        // failed verification. Renaming onto an existing file has to replace it,
        // which needs delete access to it, which the scanner may be holding for
        // another moment. Removing it first goes through the backoff above, so
        // the wait happens here instead of surfacing as a failed download.
        await rimraf(dest).catch(() => {});
        await fsp.rename(tmp, dest);
        fetchedBytes += entry.s;
        reportDownload();
        return;
      } catch (err) {
        lastError = err;
        await rimraf(tmp).catch(() => {});
        if (err.message === 'cancelled') throw err;
        if (attempt < BLOB_RETRIES) {
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }
    }
    throw new Error(`${entry.p}: ${lastError ? lastError.message : 'download failed'}`);
  };

  let cursor = 0;
  const workers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, Math.max(1, toFetch.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= toFetch.length) return;
      await fetchOne(toFetch[index]);
    }
  });
  await Promise.all(workers);
  report(PCT_DOWNLOAD_END, 'downloading');

  // ── Phase 3: settle the tree ─────────────────────────────────────────────
  // What this DOESN'T do any more, and why: it used to hash all 28,428 staged
  // files against the manifest. That pass took about twenty minutes and proved
  // nothing that was not already known, because there are only two ways a file
  // gets into this tree and both are already established:
  //
  //   downloaded — fetchOne hashes every blob as it arrives and refuses to put
  //                it in place unless the hash and the size both match. A file
  //                that is here at all is already a verified file.
  //   linked     — the same bytes, on the same disk, as the installation that
  //                is running right now. Its hash was compared against the
  //                manifest before the link was made (loadInstalledInventory).
  //
  // Hashing 2.0GB a second time to re-learn both of those is what made a fast
  // update slower than the installer it replaced, and the pass is also where the
  // patched-fs bug on app.asar turned a perfectly good tree into a failure.
  //
  // One thing the pass did catch is worth keeping: a file the app rewrites
  // WHILE staging runs. A hard link shares its metadata with the installed
  // file, so a rewrite shows up here as a changed size or modification time —
  // two numbers per file, a few seconds for the tree, no reading at all. Those
  // files, and only those, are re-fetched and re-verified.
  const restat = [];
  let settled = 0;
  await mapConcurrent(manifestFiles, INVENTORY_CONCURRENCY, async (entry) => {
    if (isCancelled()) return;
    const dest = safeJoin(stagingDir, entry.p);
    try {
      const stat = await fsp.stat(dest);
      const key = entry.p.replace(/\//g, '\\').toLowerCase();
      const known = hardLinked.has(key) ? inventory.get(key) : null;
      // Size must always be the manifest's. Modification time is only
      // meaningful for a hard link, where it is the installed file's own.
      const sizeOk = stat.size === entry.s;
      const timeOk = !known || known.mtimeMs === undefined || stat.mtimeMs === known.mtimeMs;
      if (!sizeOk || !timeOk) restat.push(entry);
    } catch {
      restat.push(entry);
    }
    settled += 1;
    if (settled % 2000 === 0) {
      report(PCT_DOWNLOAD_END + Math.round((settled / manifestFiles.length) * (100 - PCT_DOWNLOAD_END)), 'verifying');
    }
  });
  if (isCancelled()) throw new Error('cancelled');

  if (restat.length) {
    log.warn(`${restat.length} staged file(s) changed under us or are missing — re-fetching them.`);
    for (const entry of restat) {
      await rimraf(safeJoin(stagingDir, entry.p)).catch(() => {});
      await fetchOne(entry);
      const dest = safeJoin(stagingDir, entry.p);
      const stat = await fsp.stat(dest);
      if (stat.size !== entry.s || (await sha256File(dest)) !== entry.h) {
        throw new Error(`${entry.p} still does not match the manifest after re-download`);
      }
    }
  }

  // Nothing in the staged tree may exist outside the manifest.
  const strays = [];
  const sweep = async (dir) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await sweep(full); continue; }
      const rel = path.relative(stagingDir, full).replace(/\//g, '\\').toLowerCase();
      if (rel === READY_MARKER.toLowerCase()) continue;
      // Root-level only: an "Uninstall *.exe" anywhere deeper is not ours.
      if (!rel.includes('\\') && INSTALL_ONLY_FILE.test(entry.name)) continue;
      if (!byKey.has(rel)) strays.push(full);
    }
  };
  await sweep(stagingDir);
  for (const stray of strays) {
    log.warn(`Removing unexpected staged file: ${path.relative(stagingDir, stray)}`);
    await rimraf(stray).catch(() => {});
  }

  report(100, 'verifying');
  return { linked, downloaded: toFetch.length, resumed, networkBytes };
}

/**
 * Files that live in the installation but are not part of the build — the NSIS
 * uninstaller is the only one, and losing it would leave an app that cannot be
 * uninstalled from Windows Settings. Copied into the staged tree so the swap
 * carries it across.
 */
async function preserveInstallOnlyFiles(installDir, stagingDir, manifest) {
  const inManifest = new Set(manifest.files.map((e) => e.p.replace(/\//g, '\\').toLowerCase()));
  const preserved = [];
  const entries = await fsp.readdir(installDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const rel = entry.name;
    if (inManifest.has(rel.toLowerCase())) continue;
    // Our own breadcrumb from the swap that installed this version. The new
    // staged tree writes its own, so there is nothing to carry across.
    if (rel.toLowerCase() === READY_MARKER.toLowerCase()) continue;
    if (!INSTALL_ONLY_FILE.test(rel)) {
      log.warn(`Install-only file not carried across (not an uninstaller): ${rel}`);
      continue;
    }
    // A resumed tree may already hold it from the earlier attempt.
    const source = path.join(installDir, rel);
    const dest = path.join(stagingDir, rel);
    if ((await compareFile(source, dest)) === 'same') {
      preserved.push(rel);
      continue;
    }
    await fsp.copyFile(source, dest);
    preserved.push(rel);
  }
  if (preserved.length) log.info(`Preserved from the current installation: ${preserved.join(', ')}`);
  return preserved;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Swap
// ═══════════════════════════════════════════════════════════════════════════

const SWAP_HELPER_NAME = 'swap-helper.exe';

/** Where the shipped helper is: resources/ in a packaged build, the compile output in development. */
function bundledSwapHelperPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, SWAP_HELPER_NAME);
  return path.join(__dirname, '..', '..', 'swap-helper-dist', SWAP_HELPER_NAME);
}

/** Refuse anything that is not a Windows executable: a truncated copy, an empty file, a text file. */
async function assertWindowsExecutable(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(2);
    const { bytesRead } = await handle.read(head, 0, 2, 0);
    if (bytesRead !== 2 || head.toString('latin1') !== 'MZ') {
      throw new Error(`${path.basename(file)} is not a Windows executable`);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Copy the helper out of the installation, because a program cannot rename the
 * directory it is running from.
 *
 * It lands in the updater cache rather than %TEMP% for one reason: the RunOnce
 * repair guard points at this path, and %TEMP% is swept by Disk Cleanup and by
 * Windows' own storage sense. A guard whose program has been deleted is not a
 * guard.
 *
 * The helper is a compiled windows-subsystem exe (electron/services/swap-helper.cs,
 * built by scripts/build-swap-helper.js) shipped as a plain file in resources/ —
 * never inside app.asar, the one place original-fs cannot read from. The copy
 * is checked to be a real executable of the source's size before it is put in
 * place, so a bad copy can never be what the restart depends on.
 */
async function materialiseSwapHelper() {
  const source = bundledSwapHelperPath();
  const dest = cachePath(SWAP_HELPER_NAME);
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  // Copies set aside by an earlier call (below) that could not be deleted then.
  try {
    for (const name of await fsp.readdir(getCacheDir())) {
      if (name.startsWith(`${SWAP_HELPER_NAME}.prev-`)) await fsp.unlink(cachePath(name)).catch(() => {});
    }
  } catch { /* nothing to sweep */ }

  const expected = (await fsp.stat(source)).size;
  const tmp = `${dest}.tmp-${process.pid}`;
  await fsp.copyFile(source, tmp);
  const copied = (await fsp.stat(tmp)).size;
  if (copied !== expected) {
    await fsp.unlink(tmp).catch(() => {});
    throw new Error(`the swap helper copied as ${copied} bytes, expected ${expected}`);
  }
  await assertWindowsExecutable(tmp);

  // The previous copy may still be RUNNING — a helper finishing its delete of
  // the old version behind a relaunch, while this new version is already
  // checking for the next update. Windows will not let a running image be
  // deleted or overwritten, but it will let it be renamed out of the way.
  if (await pathExists(dest)) {
    try {
      await fsp.unlink(dest);
    } catch {
      await fsp.rename(dest, `${dest}.prev-${Date.now().toString(36)}`);
    }
  }
  await fsp.rename(tmp, dest);
  return dest;
}

/**
 * Write the plan and the helper to disk. Done as soon as staging finishes rather
 * than at the moment of the swap, because one of the two ways a swap starts is
 * from a 'before-quit' handler, where there is no time left to await anything.
 */
async function prepareSwap(plan) {
  const planPath = cachePath('swap-plan.json');
  await writeJsonAtomic(planPath, plan);
  const helperPath = await materialiseSwapHelper();
  return { planPath, helperPath };
}

/**
 * Everything the restart depends on, checked BEFORE the work instead of after.
 *
 * Today's lesson, twice over: both failures that cost a full staging run were
 * at the very last step — a complete, verified 1.9GB tree thrown away because
 * the 20KB helper script could not be read out of app.asar. The check costs one
 * small read and one existsSync, and turns nine minutes of wasted work into an
 * immediate, named failure that the log can explain.
 */
async function preflightSwapReadiness() {
  const source = bundledSwapHelperPath();
  if (!(await pathExists(source))) {
    throw new Error(`this build ships no swap helper at ${source} — refusing to start`);
  }
  const helperPath = await materialiseSwapHelper();
  const size = (await fsp.stat(helperPath)).size;
  log.info(`Preflight ok: helper ${size} bytes at ${helperPath}.`);
}

/**
 * Start the helper. Synchronous by design: the quit path calls this while
 * Electron is already tearing down, where a promise may never get another turn.
 *
 * `relaunch` is false when the swap happens because the user closed the app.
 * Reopening it then would be the update deciding, on its own, that the user did
 * not mean to close it.
 */
function startSwap({ planPath, helperPath }, { relaunch }) {
  const args = ['--plan', planPath];
  if (!relaunch) args.push('--no-relaunch');

  // ── detached: true — and this time it is the whole point ────────────────
  // On Windows, libuv puts every child spawned WITHOUT detached into a Job
  // Object flagged KILL_ON_JOB_CLOSE. When this process exits, Windows closes
  // that job and kills everything in it. That is what happened to the
  // PowerShell helper this exe replaces: swap.log stopped at "Waiting for
  // KnockDesk AI (pid …) to exit…" because the helper died in the same instant
  // the app did. child.unref() is no defence — it only affects the event loop.
  //
  // detached:true keeps the child out of the job, but libuv implements it with
  // DETACHED_PROCESS ("no console"), and a console program such as
  // powershell.exe exits at once when there is no console to attach to — which
  // is why the earlier fix went the other way, and why neither way could work
  // for a script. The helper is therefore a WINDOWS-subsystem exe
  // (csc /target:winexe): it needs no console, so detached runs it, and detached
  // means it outlives the app. Measured in plain Node and in the real Electron
  // runtime, and pinned by swap-helper.test.js ("outlives the process that
  // started it").
  //
  // stdio 'ignore': a windows-subsystem program writes nothing to stdio, and a
  // file handle inherited by a child that outlives us would just hold that
  // file open. Its account of itself is swap.log, next to the plan.
  //
  // cwd: the helper's own folder, never this process's. A child inherits its
  // parent's current directory, ours is the install folder (the shortcut's
  // "Start in"), and a folder that is any process's current directory cannot
  // be renamed. The helper moves itself out as well; this is the second lock.
  const child = spawn(helperPath, args, {
    cwd: path.dirname(helperPath),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (err) => log.error('Swap helper could not be started:', err.message));
  child.unref();
  log.info(`Swap helper started (pid ${child.pid}, relaunch=${relaunch}); it logs to ${cachePath('swap.log')}.`);
  return child.pid;
}

/**
 * Wait for the helper to prove it is actually running, before the app quits.
 *
 * The helper's first act after reading the plan is to write to swap.log, so the
 * file growing is proof that a real helper process got as far as reading its
 * plan. Until that happens the app must NOT quit: a quit on the strength
 * of a pid that turned out to be a process which exited instantly is exactly
 * how a user ends up staring at an app that closed and never came back.
 *
 * On failure the caller keeps the app open and hands the update to NSIS, which
 * is slow but has never lost anybody's installation.
 */
async function confirmSwapHelperAlive(sizeBefore, timeoutMs = 8000) {
  const logFile = cachePath('swap.log');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let size = -1;
    try { size = (await fsp.stat(logFile)).size; } catch { size = -1; }
    if (size > sizeBefore) return true;
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
}

/** The helper's log size right now, so growth can be detected afterwards. */
async function swapLogSize() {
  try { return (await fsp.stat(cachePath('swap.log'))).size; } catch { return -1; }
}

/**
 * Turn the manifest of a swap that just succeeded into an inventory cache.
 *
 * This is the payoff the whole cache exists for: the manifest already states
 * every file's hash, and those files were just put there, so the next update
 * needs NO hashing at all — one stat per file to record the modification time
 * the cache validates against, and nothing is read.
 *
 * The two records are NOT the same shape, which is the trap this function
 * exists to close. A manifest entry is { p: "resources/app.asar", h, s }; an
 * inventory record is { p: "resources\\app.asar" lowercased, h, s, m }. Writing
 * the manifest straight into the cache — which is what used to happen here —
 * produced a file the inventory loader rejects outright, so the "needs no
 * rehash" line was printed and then 2.0GB was hashed anyway on the next update.
 */
async function promotePendingManifest(pending) {
  if (!Array.isArray(pending.files) || !pending.files.length) return;
  const installDir = getInstallDir();
  const started = Date.now();
  const records = [];
  let missing = 0;

  await mapConcurrent(pending.files, INVENTORY_CONCURRENCY, async (entry) => {
    const full = safeJoin(installDir, entry.p);
    if (!full) return;
    try {
      const stat = await fsp.stat(full);
      // A file that is not the size the manifest claims was not written by this
      // release. Leaving it out means the next update hashes it, which is the
      // safe direction to be wrong in.
      if (stat.size !== entry.s) { missing += 1; return; }
      records.push({
        p: entry.p.replace(/\//g, '\\').toLowerCase(),
        h: entry.h,
        s: entry.s,
        m: stat.mtimeMs,
      });
    } catch {
      missing += 1;
    }
  });

  await writeJsonAtomic(cachePath('installed-manifest.json'), {
    schema: 2,
    version: pending.version,
    files: records,
  });
  log.info(
    `Promoted manifest for ${pending.version}: ${records.length} file(s) recorded` +
    `${missing ? `, ${missing} skipped` : ''} in ${Date.now() - started}ms. ` +
    'The next update needs no rehash.'
  );
}

/**
 * A pending manifest for a version that is not running means a restart was
 * asked for and the machine came back on the old version. The helper's log
 * knows why; put its verdict here too, so one file tells the whole story.
 */
async function explainFailedSwap(version) {
  try {
    const text = await fsp.readFile(cachePath('swap.log'), 'utf8');
    const lines = text.trim().split(/\r?\n/);
    let start = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (/Swap helper started/.test(lines[i])) { start = i; break; }
    }
    const run = start >= 0 ? lines.slice(start) : lines.slice(-20);
    const verdict = run.filter((l) => /\[(ERROR|WARN)\]/.test(l));
    log.warn(
      `The swap to ${version} did not take. swap.log's last run says: ` +
      (verdict.length ? verdict.join(' | ') : run.slice(-3).join(' | '))
    );
  } catch {
    log.warn(`The swap to ${version} did not take, and there is no swap.log to say why — the helper never got as far as writing one.`);
  }
}

/**
 * Called once at boot, before any window exists.
 *
 * Two jobs. First, finish or undo a swap that a power cut interrupted — the
 * helper's RunOnce entry normally does this, but a repair that runs here is
 * faster and covers the case where RunOnce was stripped. Second, promote the
 * manifest of a swap that succeeded, so the NEXT update needs no hashing at all.
 */
async function recoverAfterBoot() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    const pending = await readJsonIfPresent(cachePath('pending-manifest.json'));
    if (pending) {
      if (pending.version === app.getVersion()) {
        await promotePendingManifest(pending);
      } else {
        log.info(`Discarding pending manifest for ${pending.version} (running ${app.getVersion()}).`);
        await explainFailedSwap(pending.version);
      }
      await rimraf(cachePath('pending-manifest.json')).catch(() => {});
    }

    // Deleting the previous version means deleting ~2.0GB, and boot is the one
    // moment where that disk time is felt: the window is painting, Hermes and
    // the runtimes are loading. It is finished business either way, so it waits
    // until the app is actually up.
    setTimeout(() => { void sweepFinishedSwapLeftovers(); }, POST_BOOT_SWEEP_DELAY_MS).unref?.();
  } catch (err) {
    log.warn('Boot recovery could not complete:', err.message);
  }
}

/**
 * Remove what a completed swap left behind: the previous version's directory
 * (the helper cannot always delete it, because a file in it may still have been
 * locked at that moment) and any staged tree that is no longer ahead of us.
 */
async function sweepFinishedSwapLeftovers() {
  try {
    const installDir = getInstallDir();
    const parent = path.dirname(installDir);
    const base = path.basename(installDir).toLowerCase();

    let siblings = [];
    try { siblings = await fsp.readdir(parent, { withFileTypes: true }); } catch { siblings = []; }
    for (const entry of siblings) {
      if (!entry.isDirectory()) continue;
      const name = entry.name.toLowerCase();
      // .old-*   the previous installation, left by a completed swap.
      // .stale-* a scrap staged tree that could not be deleted at the time, so
      //          clearStagingDir moved it out of the way instead. Boot is the
      //          right moment to retry: whatever was reading it then is not now.
      const leftover = name.startsWith(`${base}.old-`) || name.startsWith(`${base}.staging.stale-`);
      if (!leftover) continue;
      log.info(`Removing leftover ${entry.name}.`);
      await rimraf(path.join(parent, entry.name))
        .catch((err) => log.warn(`Could not remove ${entry.name} — will retry next boot: ${err.message}`));
    }

    // A staged tree that is not newer than what is running is spent. Note the
    // check is "not newer" rather than "equal": a rolled-back swap leaves a tree
    // for a version this machine has decided not to run.
    const staging = getStagingDir();
    const marker = await readJsonIfPresent(path.join(staging, READY_MARKER));
    if (marker && !isNewerVersion(marker.version, app.getVersion())) {
      log.info(`Removing staged tree for ${marker.version}; ${app.getVersion()} is running.`);
      await rimraf(staging).catch(() => {});
      await rimraf(cachePath('staging-intent.json')).catch(() => {});
    }
  } catch (err) {
    log.warn('Leftover sweep could not complete:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Controller
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {object} options
 * @param {() => Electron.BrowserWindow|null} options.getMainWindow
 * @param {() => boolean} options.isAutoUpdateEnabled
 * @param {() => Promise<void>} options.teardown   pre-install child teardown
 * @param {() => void} options.quit                the app's own shutdown path
 * @param {(reason: string) => void} options.fallback  hand over to NSIS
 * @returns {{ check: Function, download: Function, applyPreference: Function }}
 */
function setupStagedUpdater(options) {
  const { getMainWindow, isAutoUpdateEnabled, teardown, quit, fallback } = options;

  const state = {
    autoDownload: !!isAutoUpdateEnabled(),
    checkTimer: null,
    checkInFlight: null,
    prepareInFlight: null,
    ready: null,          // { version, stagingDir, manifest, preserved }
    available: null,      // { version, feed }
    installRequested: false,
    quitting: false,
    cancelled: false,
    handedOver: false,
    failureCount: 0,
  };

  const sendStatus = (data) => {
    try {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('update-status', data);
    } catch (err) {
      log.warn('Could not reach the renderer:', err.message);
    }
  };

  const clearTimer = () => {
    if (!state.checkTimer) return;
    clearTimeout(state.checkTimer);
    state.checkTimer = null;
  };

  const schedule = (delayMs, reason) => {
    if (state.quitting || state.installRequested || state.ready || state.handedOver) return;
    clearTimer();
    log.info(`Next check in ${Math.round(delayMs / 1000)}s (${reason}).`);
    state.checkTimer = setTimeout(() => {
      state.checkTimer = null;
      void runCheck(reason);
    }, delayMs);
    if (typeof state.checkTimer.unref === 'function') state.checkTimer.unref();
  };

  /**
   * Give the whole update up to the NSIS path. Done once, and it is a
   * DEMOTION, not an error: the user still gets the update, by the old route.
   */
  const handOver = (reason) => {
    if (state.handedOver) return;
    state.handedOver = true;
    state.cancelled = true;
    clearTimer();
    log.warn(`Handing updates to the NSIS path — ${reason}`);
    try { ipcMain.removeHandler('install-update'); } catch { /* not registered */ }
    try { ipcMain.removeHandler('check-for-updates'); } catch { /* not registered */ }
    try {
      fallback(reason);
    } catch (err) {
      log.error('The NSIS fallback itself failed to start:', err);
      sendStatus({ status: 'error', message: 'Updates are temporarily unavailable.' });
    }
  };

  const recordFailure = (err, notify) => {
    state.failureCount += 1;
    const message = err && err.message ? err.message : String(err);
    log.error(`Attempt ${state.failureCount} failed: ${message}`);
    // Three honest attempts at the fast path, then stop gambling with the
    // user's update and let the route that has always worked take it.
    if (state.failureCount >= 3) {
      handOver(`staged update failed ${state.failureCount} times (${message})`);
      return;
    }
    if (notify) sendStatus({ status: 'error', message });
    const delay = RETRY_DELAYS_MS[Math.min(state.failureCount - 1, RETRY_DELAYS_MS.length - 1)];
    schedule(delay, 'retry-after-failure');
  };

  // ── Check ────────────────────────────────────────────────────────────────
  const runCheck = (reason = 'unspecified') => {
    if (state.quitting || state.installRequested || state.handedOver) return Promise.resolve(null);
    if (state.ready) {
      log.info(`Check skipped (${reason}): ${state.ready.version} is staged and waiting for restart.`);
      return Promise.resolve(null);
    }
    if (state.checkInFlight) return state.checkInFlight;

    clearTimer();
    log.info(`Checking for updates (${reason}); current=${app.getVersion()}.`);
    sendStatus({ status: 'checking' });

    state.checkInFlight = (async () => {
      const base = getFeedBase();
      if (!base.startsWith('https://')) {
        handOver(`feed ${base} is not https`);
        return null;
      }
      const feedUrl = `${base}/${FEED_FILE}?ts=${Date.now()}`;
      let feed;
      try {
        feed = JSON.parse(await httpGetText(feedUrl));
      } catch (err) {
        // 404 is not a fault, it is an answer: this channel publishes no staged
        // releases (yet). Retrying it three times before falling back would just
        // delay every one of those users' updates by several minutes.
        if (/HTTP 40[34]/.test(err.message || '')) {
          handOver('the channel publishes no staged updates');
          return null;
        }
        throw err;
      }

      if (feed.schema !== 1) {
        handOver(`feed schema ${feed.schema} is not supported by this build`);
        return null;
      }
      if (feed.enabled === false) {
        handOver('staged updates are switched off in the feed');
        return null;
      }
      if (typeof feed.version !== 'string' || !feed.version) throw new Error('feed has no version');

      if (!isNewerVersion(feed.version, app.getVersion())) {
        log.info(`No newer version (feed ${feed.version}, running ${app.getVersion()}).`);
        state.failureCount = 0;
        sendStatus({ status: 'not-available' });
        schedule(NORMAL_CHECK_INTERVAL_MS, 'periodic');
        return null;
      }
      // A release can declare that machines older than X must take the full
      // installer — the escape hatch for a build whose layout moved too far.
      if (feed.minStagedFrom && isNewerVersion(feed.minStagedFrom, app.getVersion())) {
        handOver(`feed requires at least ${feed.minStagedFrom} for a staged update`);
        return null;
      }

      state.failureCount = 0;
      state.available = { version: feed.version, feed };
      log.info(`Update available: ${app.getVersion()} → ${feed.version}.`);
      sendStatus({ status: 'available', version: feed.version });

      if (state.autoDownload) void runPrepare('automatic');
      return feed;
    })()
      .catch((err) => {
        recordFailure(err, false);
        return null;
      })
      .finally(() => { state.checkInFlight = null; });

    return state.checkInFlight;
  };

  // ── Prepare (download + stage + verify) ──────────────────────────────────
  const runPrepare = (reason = 'unspecified') => {
    if (state.quitting || state.installRequested || state.handedOver) {
      return Promise.reject(new Error('The app is shutting down.'));
    }
    if (state.ready) return Promise.resolve(state.ready);
    if (state.prepareInFlight) return state.prepareInFlight;
    // Nothing has been checked yet — the Download button in Settings can be the
    // very first thing that happens. Check, then carry straight on into the
    // preparation the user actually asked for, rather than returning nothing and
    // leaving the button looking broken.
    if (!state.available) {
      return runCheck(reason).then(() => (state.available ? runPrepare(reason) : null));
    }

    const { version, feed } = state.available;
    const installDir = getInstallDir();
    const stagingDir = getStagingDir();
    const base = getFeedBase();
    const blobBase = feed.blobBase || 'blobs/';

    log.info(`Preparing ${version} in ${stagingDir} (${reason}).`);
    let lastPercent = -1;
    let lastPhase = null;
    const report = (percent, phase) => {
      const clamped = Math.max(0, Math.min(100, percent));
      // A progress bar that goes backwards reads as a restart, and a user who
      // sees one stops believing the number. The phase slices above already make
      // that impossible; this keeps it impossible whatever a future phase does.
      if (clamped < lastPercent) return;
      if (clamped === lastPercent && phase === lastPhase) return;
      lastPercent = clamped;
      lastPhase = phase;
      sendStatus({ status: 'downloading', percent: clamped, phase, version });
    };

    state.prepareInFlight = (async () => {
      report(0, 'preparing');

      // Before anything expensive: can this machine actually perform the swap?
      await preflightSwapReadiness();

      // The feed is fetched over TLS from our own domain, so a hostile feed
      // already means a deeper compromise — but a manifest or blob URL is the one
      // value in it that could redirect the download itself somewhere else, and
      // pinning it to the feed's own origin costs two lines.
      const stagedRoot = new URL(`${base}/staged/`);
      const sameOrigin = (candidate) => {
        const url = new URL(candidate, stagedRoot);
        if (url.origin !== stagedRoot.origin) {
          throw new Error(`the feed points outside its own host: ${url.origin}`);
        }
        return url.toString();
      };

      const manifestUrl = sameOrigin(feed.manifest || `manifests/${version}.json.gz`);
      const manifestText = await httpGetText(manifestUrl);
      const manifestDigest = crypto.createHash('sha256').update(manifestText, 'utf8').digest('hex');
      if (typeof feed.manifestSha256 === 'string' && feed.manifestSha256) {
        if (manifestDigest !== feed.manifestSha256.toLowerCase()) {
          throw new Error('the manifest does not match the hash the feed published for it');
        }
      }
      const manifest = validateManifest(JSON.parse(manifestText), version);
      const resolvedBlobBase = sameOrigin(blobBase);
      log.info(`Manifest for ${version}: ${manifest.files.length} files, ${(manifest.totalBytes / 1048576).toFixed(0)} MB.`);

      // A tree left by an earlier attempt at THIS release — a restart whose
      // swap did not happen, a download the app was closed in the middle of —
      // is resumed, not rebuilt. Resumed is not trusted: buildStagingTree checks
      // every file it finds (a link must still be the installed file, anything
      // else must still hash to the manifest) and replaces what fails. What is
      // saved is the linking and the download; what is guaranteed is unchanged.
      // Before this, one failed swap cost the whole six-minute staging again.
      //
      // The intent file lives in the cache, outside the tree, and names the
      // release the tree was started for. Any other tree is stale and is
      // cleared — moved aside if it cannot be deleted right now, because a tree
      // nobody can remove must not become a machine nobody can update.
      await fsp.mkdir(getCacheDir(), { recursive: true });
      const intentPath = cachePath('staging-intent.json');
      const intent = await readJsonIfPresent(intentPath);
      const resumable = !!intent
        && intent.version === version
        && intent.fromVersion === app.getVersion()
        && intent.manifestSha256 === manifestDigest
        && await pathExists(stagingDir);
      if (resumable) {
        log.info(`Resuming the staged tree an earlier attempt left for ${version}; every file in it is re-checked.`);
        // Not armed while it is being worked on: the marker is written last.
        await rimraf(path.join(stagingDir, READY_MARKER)).catch(() => {});
      } else {
        await clearStagingDir(stagingDir);
      }
      await writeJsonAtomic(intentPath, {
        schema: 1,
        version,
        fromVersion: app.getVersion(),
        manifestSha256: manifestDigest,
        startedAt: new Date().toISOString(),
      });
      await fsp.mkdir(stagingDir, { recursive: true });

      const free = freeSpaceBytes(path.dirname(installDir));
      if (free !== null && free < FREE_SPACE_HEADROOM_BYTES) {
        throw new Error(`not enough free disk space (${(free / 1073741824).toFixed(1)} GB available)`);
      }

      const inventory = await loadInstalledInventory(installDir, (done, total) => {
        report(Math.round((done / total) * PCT_INVENTORY_END), 'preparing');
      });

      const result = await buildStagingTree({
        manifest,
        installDir,
        stagingDir,
        blobBase: resolvedBlobBase,
        inventory,
        report,
        isCancelled: () => state.cancelled || state.quitting,
      });

      const preserved = await preserveInstallOnlyFiles(installDir, stagingDir, manifest);

      const executable = safeJoin(stagingDir, manifest.executable);
      if (!executable || !(await pathExists(executable))) {
        throw new Error('the staged tree has no executable — refusing to arm it');
      }

      // Written last, on purpose: until this exists the tree is scrap, and the
      // helper refuses to swap a tree without it.
      await writeJsonAtomic(path.join(stagingDir, READY_MARKER), {
        schema: 1,
        version,
        fromVersion: app.getVersion(),
        completedAt: new Date().toISOString(),
        files: manifest.files.length,
        executable: manifest.executable,
      });
      // Each of the last three steps gets its own line. They are short steps, so
      // there was nothing to say about them — until a run spent six minutes and
      // forty-five seconds somewhere between "preserved the uninstaller" and
      // "read the swap helper", and there was no way to tell which one had it.
      log.info('Staged tree armed; writing the pending manifest.');
      // Kept outside the staged tree so the swap cannot take it with it.
      await writeJsonAtomic(cachePath('pending-manifest.json'), {
        schema: 1,
        version,
        files: manifest.files,
      });
      log.info('Pending manifest written; preparing the swap plan and helper.');

      const swap = await prepareSwap({
        schema: 1,
        version,
        fromVersion: app.getVersion(),
        installDir,
        stagingDir,
        executable: manifest.executable,
        preserved,
        pid: process.pid,
        cacheDir: getCacheDir(),
        createdAt: new Date().toISOString(),
      });

      state.ready = { version, stagingDir, manifest, preserved, swap };
      state.failureCount = 0;
      clearTimer();
      log.info(
        `${version} is staged and verified — ${result.linked} reused` +
        (result.resumed ? `, ${result.resumed} kept from an earlier attempt` : '') +
        `, ${result.downloaded} downloaded ` +
        `(${(result.networkBytes / 1048576).toFixed(1)} MB over the network). Restart will take seconds.`
      );
      sendStatus({ status: 'downloaded', version });
      return state.ready;
    })()
      .catch(async (err) => {
        // The tree stays for the next attempt to resume (see above). It is not
        // armed: the ready marker is written last, so a run that failed never
        // wrote one — this only makes sure of it.
        await rimraf(path.join(stagingDir, READY_MARKER)).catch(() => {});
        if (err && err.message === 'cancelled') {
          log.info('Preparation cancelled.');
          return null;
        }
        recordFailure(err, reason === 'user-request');
        if (reason === 'user-request') throw err;
        return null;
      })
      .finally(() => { state.prepareInFlight = null; });

    return state.prepareInFlight;
  };

  // ── Install (the swap) ───────────────────────────────────────────────────
  const runInstall = async () => {
    if (state.installRequested) {
      log.info('Duplicate restart request ignored.');
      return { success: true, alreadyInProgress: true };
    }
    if (!state.ready) {
      const message = 'The update is still being prepared.';
      sendStatus({ status: 'error', message });
      return { success: false, error: 'UPDATE_NOT_READY' };
    }

    const { version, stagingDir, manifest } = state.ready;
    const installDir = getInstallDir();

    // The tree was verified when it was built; confirm it is still there and
    // still armed before anything is torn down.
    const marker = await readJsonIfPresent(path.join(stagingDir, READY_MARKER));
    const executable = safeJoin(stagingDir, manifest.executable);
    if (!marker || marker.version !== version || !executable || !(await pathExists(executable))) {
      state.ready = null;
      const message = 'The prepared update is no longer on disk; it will be prepared again.';
      log.warn(message);
      sendStatus({ status: 'error', message });
      schedule(RETRY_DELAYS_MS[0], 'recover-missing-staging');
      return { success: false, error: 'STAGING_MISSING' };
    }

    // The plan and the helper were written when staging finished, which may
    // have been hours ago. Nothing should have removed them since — but if
    // something did, this is the last moment anyone can notice: after teardown
    // the app is quitting and a missing plan means the helper starts, finds
    // nothing to do, and exits (code 2) without a word, leaving the user staring
    // at an app that closed and never came back updated. Re-writing them costs
    // one small write and one 20KB copy.
    try {
      const planOk = await pathExists(state.ready.swap.planPath);
      const helperOk = await pathExists(state.ready.swap.helperPath);
      if (!planOk || !helperOk) {
        log.warn(`Swap files went missing (plan=${planOk}, helper=${helperOk}); writing them again.`);
        state.ready.swap = await prepareSwap({
          schema: 1,
          version,
          fromVersion: app.getVersion(),
          installDir,
          stagingDir,
          executable: manifest.executable,
          preserved: state.ready.preserved,
          pid: process.pid,
          cacheDir: getCacheDir(),
          createdAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      const message = `the swap could not be armed: ${err.message}`;
      log.error(message);
      sendStatus({ status: 'error', message });
      return { success: false, error: 'SWAP_NOT_ARMED', message };
    }

    state.installRequested = true;
    state.quitting = true;
    clearTimer();
    log.info('Restart requested; tearing down children before the swap.');

    try {
      // Same teardown the NSIS path uses, and for the same reason: anything
      // still running out of the install directory holds a handle that would
      // make the rename fail.
      await teardown();

      const before = await swapLogSize();
      startSwap(state.ready.swap, { relaunch: true });

      // Proof, not hope. Quitting on a pid alone is what turned a helper that
      // exited instantly into an app that closed and never came back.
      if (!(await confirmSwapHelperAlive(before))) {
        state.installRequested = false;
        state.quitting = false;
        const message = 'the swap helper did not start; the update will be installed the slower way';
        log.error(message);
        sendStatus({ status: 'error', message });
        handOver('the swap helper could not be started');
        return { success: false, error: 'SWAP_HELPER_DEAD', message };
      }

      log.info('Swap helper is alive and waiting for this process to exit; quitting now.');
      quit();
      return { success: true };
    } catch (err) {
      state.installRequested = false;
      state.quitting = false;
      const message = err && err.message ? err.message : String(err);
      log.error('Could not start the swap:', message);
      sendStatus({ status: 'error', message });
      schedule(RETRY_DELAYS_MS[0], 'retry-after-swap-handoff');
      return { success: false, error: 'SWAP_HANDOFF_FAILED', message };
    }
  };

  // ── Preference ───────────────────────────────────────────────────────────
  const applyPreference = (enabled) => {
    state.autoDownload = !!enabled;
    log.info(`Automatic updates ${state.autoDownload ? 'enabled' : 'disabled'}.`);
    if (!state.autoDownload) return;
    if (state.ready) return;
    if (state.available) void runPrepare('preference-enabled');
    else void runCheck('preference-enabled');
  };

  // ── IPC ──────────────────────────────────────────────────────────────────
  ipcMain.removeHandler('install-update');
  ipcMain.handle('install-update', runInstall);

  ipcMain.removeHandler('check-for-updates');
  ipcMain.handle('check-for-updates', async () => {
    const feed = await runCheck('user-request');
    return { success: !!feed, version: feed ? feed.version : null };
  });

  app.once('before-quit', () => {
    state.quitting = true;
    state.cancelled = true;
    clearTimer();

    // Install on quit, which is what the NSIS path has always done through
    // autoInstallOnAppQuit. Without it, a user who never presses the button
    // never gets the update. What changes is the cost: NSIS ran a silent
    // installer that churned ~4.6GB after the window closed, and this is two
    // renames.
    //
    // Guarded on installRequested because the Restart button arrives here too:
    // runInstall sets that flag before it asks the app to quit, so the swap it
    // has already started is not started a second time.
    if (!state.ready || state.installRequested || !state.autoDownload) return;
    try {
      state.installRequested = true;
      startSwap(state.ready.swap, { relaunch: false });
      log.info(`${state.ready.version} will be in place the next time KnockDesk AI is opened.`);
    } catch (err) {
      // Quitting must never fail because an update could not start. The staged
      // tree stays where it is and the next launch offers it again.
      state.installRequested = false;
      log.warn('Could not start the swap on quit:', err.message);
    }
  });

  log.info(`Initialised; current=${app.getVersion()}, automatic=${state.autoDownload}, feed=${getFeedBase()}.`);
  schedule(INITIAL_CHECK_DELAY_MS, 'startup');

  return {
    check: runCheck,
    download: (reason) => runPrepare(reason || 'user-request'),
    applyPreference,
    // main.js must not install these handles over the NSIS ones if the very
    // first check already handed the update over.
    isHandedOver: () => state.handedOver,
  };
}

module.exports = { setupStagedUpdater, recoverAfterBoot };

// The pieces that decide whether a downloaded byte is allowed to become part of
// the installed app. Exported so staged-updater.test.js can drive them directly
// rather than through a network and an Electron app object — the traversal and
// hash-mismatch cases in particular have to be provable, not assumed.
module.exports.__test = {
  httpGetText,
  isNewerVersion,
  safeJoin,
  validateManifest,
  buildStagingTree,
  preserveInstallOnlyFiles,
  READY_MARKER,
  // The staged tree is only as correct as the inventory it was linked from, so
  // the inventory's own rules about when a cached hash may be believed are now
  // part of the guarantee and are tested directly.
  loadInstalledInventory,
  getCacheDir,
  compareFile,
  bundledSwapHelperPath,
  materialiseSwapHelper,
};
