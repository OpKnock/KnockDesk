// KnockDesk install-time core protection (runs as plain Node, no Electron).
//
// The installer calls this after copying the files:
//   set ELECTRON_RUN_AS_NODE=1
//   "$INSTDIR\KnockDesk.exe" "$INSTDIR\resources\protect-core.mjs" "$INSTDIR\resources\app.asar"
//
// What it does, on the installed machine, as the installing user:
//   1. reads the asar header and locates the protected entries (byte ranges)
//   2. generates a fresh random 256-bit key for THIS installation
//   3. encrypts the reserved 32-byte-prefixed payload of each entry in place
//      (AES-256-GCM; same byte length, so the archive layout never moves)
//   4. stores the key in the user profile: core-key.raw (recovery) and
//      core-key.dpapi.bin (DPAPI CurrentUser, what the app boots from)
//
// Why this shape: the release archive ships the protected entries as padded
// plaintext; the per-install key exists only on the installed machine and is
// wrapped by DPAPI for that Windows account. Copying the install folder to
// another machine therefore copies ciphertext that cannot be unwrapped.
//
// Failure policy: never destroy a working install. Every entry is verified
// (prefix present, sizes stable) before a byte is written, already-encrypted
// entries are skipped, and any failure leaves the archive exactly as it was.
import { openSync, readSync, writeSync, closeSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createCipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Electron patches fs so that any path containing ".asar" is opened as a
// member of an archive. This script deliberately touches the archive ITSELF
// as bytes, so asar handling must be off for this process.
process.noAsar = true;

const HERE = dirname(fileURLToPath(import.meta.url));

const PROTECTED = [
  'electron/main.jsc',
  'electron/services/knockdesk-bridge.js',
  'electron/services/knockdesk-plugin.js',
  'electron/main/bootstrap/knockdesk-bootstrap.js',
  'electron/main/ipc/knockdesk-remote-handlers.js',
  'electron/services/hermes-manager.js',
  'electron/services/computer-manager.js',
  'electron/services/cdp-shim.js',
];

const PREFIX = 32;
const MAGIC = Buffer.from('KD01', 'ascii');
const asar = process.argv[2] || join(HERE, 'app.asar');

const keyDir = process.env.KNOCKDESK_CORE_KEY_DIR
  || join(process.env.APPDATA || process.cwd(), 'knockdesk');
const rawKeyPath = join(keyDir, 'core-key.raw');
const dpapiPath = join(keyDir, 'core-key.dpapi.bin');

const log = (s) => console.log('[protect-core] ' + s);
const fail = (s) => { console.error('[protect-core] ' + s); process.exit(1); };

// ---- read the asar header -------------------------------------------------
function readHeader(p) {
  const fd = openSync(p, 'r');
  try {
    const sz = Buffer.alloc(8);
    readSync(fd, sz, 0, 8, 0);
    const headerSize = sz.readUInt32LE(4);
    if (headerSize < 8 || headerSize > 256 * 1024 * 1024) fail('implausible asar header size: ' + headerSize);
    const buf = Buffer.alloc(headerSize);
    readSync(fd, buf, 0, headerSize, 8);
    // Pickle layout, matching @electron/asar's getRawHeader: the header
    // buffer starts with its own payload size, then the string length, then
    // the JSON. So the JSON begins 8 bytes in, not 4.
    const jsonLen = buf.readUInt32LE(4);
    if (jsonLen < 2 || 8 + jsonLen > headerSize) fail('implausible asar header string length: ' + jsonLen);
    const json = buf.subarray(8, 8 + jsonLen).toString('utf8');
    return { header: JSON.parse(json), headerSize };
  } finally { closeSync(fd); }
}

function findEntry(header, rel) {
  let node = header;
  for (const part of rel.split('/')) {
    if (!node.files || !node.files[part]) return null;
    node = node.files[part];
  }
  return node.files ? null : node;
}

if (!existsSync(asar)) fail('archive not found: ' + asar);
log('archive: ' + asar);
const { header, headerSize } = readHeader(asar);
const base = 8 + headerSize;

// ---- locate every byte range first; touch nothing until all checks pass ----
const plan = [];
for (const rel of PROTECTED) {
  const node = findEntry(header, rel);
  if (!node) fail('protected entry missing from the archive: ' + rel);
  if (!node.size || node.size < PREFIX + 16) fail('protected entry is too small: ' + rel);
  if (node.unpacked) fail('protected entry is marked unpacked: ' + rel);
  plan.push({ rel, offset: base + parseInt(node.offset, 10), size: node.size });
}

// ---- decide the key -------------------------------------------------------
let key = null;
let freshKey = false;
if (existsSync(rawKeyPath)) {
  key = readFileSync(rawKeyPath);
  if (key.length !== 32) fail('existing ' + rawKeyPath + ' is not 32 bytes; refusing to continue');
  log('reusing the existing per-install key');
} else {
  key = randomBytes(32);
  freshKey = true;
  log('generated a fresh 256-bit key for this installation');
}

// ---- verify the state of every entry before writing anything --------------
const fd = openSync(asar, 'r+');
try {
  const states = [];
  for (const item of plan) {
    const head = Buffer.alloc(PREFIX);
    readSync(fd, head, 0, PREFIX, item.offset);
    if (head.subarray(0, 4).equals(MAGIC)) {
      states.push('encrypted');
    } else {
      let zeros = true;
      for (let i = 0; i < PREFIX; i++) if (head[i] !== 0) { zeros = false; break; }
      if (!zeros) fail('unexpected layout (no reserved prefix) in: ' + item.rel
        + '; this build is not encryptable in place');
      states.push('plaintext');
    }
  }
  const already = states.filter((s) => s === 'encrypted').length;
  if (already === states.length) {
    log('all ' + already + ' entries are already encrypted; nothing to do');
  } else if (already > 0 && freshKey) {
    fail('some entries are encrypted but no raw key file exists; '
      + 'cannot encrypt the rest with a new key without orphaning them');
  } else {
    let done = 0;
    for (let i = 0; i < plan.length; i++) {
      if (states[i] === 'encrypted') continue;
      const item = plan[i];
      const range = Buffer.alloc(item.size);
      readSync(fd, range, 0, item.size, item.offset);
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(range.subarray(PREFIX)), c.final()]);
      const blob = Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
      if (blob.length !== item.size) fail('internal error: length drift on ' + item.rel);
      writeSync(fd, blob, 0, blob.length, item.offset);
      done++;
    }
    log('encrypted ' + done + ' of ' + plan.length + ' protected entries in place');
  }
} finally { closeSync(fd); }

// ---- persist the key ------------------------------------------------------
mkdirSync(keyDir, { recursive: true });
if (freshKey) writeFileSync(rawKeyPath, key, { mode: 0o600 });
const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
// Add-Type loads System.Security: Windows PowerShell 5.1 does not preload the
// ProtectedData class and fails with TypeNotFound on a stock Windows install.
const psHead = '$ErrorActionPreference="Stop";Add-Type -AssemblyName System.Security;';
let dpapiOk = false;
try {
  const psWrite = psHead
    + '$b64=[Console]::In.ReadToEnd().Trim();'
    + '$k=[Convert]::FromBase64String($b64);'
    + '$blob=[Security.Cryptography.ProtectedData]::Protect($k,$null,'
    + '[Security.Cryptography.DataProtectionScope]::CurrentUser);'
    + '[IO.File]::WriteAllBytes(' + psQuote(dpapiPath) + ',$blob)';
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psWrite],
    { input: key.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 60000 });
  // Read it back through DPAPI so a wrap this machine cannot unwrap is caught
  // at install time instead of at first boot.
  const psRead = psHead
    + '$b=[IO.File]::ReadAllBytes(' + psQuote(dpapiPath) + ');'
    + '$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'
    + '[Security.Cryptography.DataProtectionScope]::CurrentUser);'
    + '[Convert]::ToBase64String($p)';
  const back = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psRead],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim();
  dpapiOk = Buffer.from(back, 'base64').equals(key);
  if (dpapiOk) log('DPAPI CurrentUser wrap written and verified: ' + dpapiPath);
  else console.warn('[protect-core] the DPAPI wrap did not round-trip; keeping the raw key as the boot path.');
} catch (e) {
  console.warn('[protect-core] DPAPI wrap failed (' + ((e && e.message) || e) + '); '
    + 'the app will boot from the raw key file instead.');
}

log('done. ' + rawKeyPath + (dpapiOk
  ? ' is the recovery copy: keep it out of shared backups, or delete it once you are satisfied.'
  : ' is the active key because the DPAPI wrap is unusable: keep it safe.'));
