// Build the protected-core archive in one pass.
//
//   node scripts/security/build-encrypted.mjs [extractDir] [outAsar] [keyFile]
//
// Steps: extract the current archive -> refresh the loader -> reserve a
// 32-byte prefix on each protected entry -> build the integrity manifest over
// the final layout (stripped payload) -> AES-256-GCM encrypt the reserved
// payload -> repack -> verify by decrypting the packed result.
//
// Format, per protected entry (file name never changes; Node picks its module
// handler from the name, so a .enc suffix would stop the bytecode loading):
//   plaintext build  [32 zero bytes][payload unchanged]
//   encrypted build  'KD01' + [12-byte IV][16-byte GCM tag][ciphertext]
// The reserved prefix is what later lets the installer encrypt the same byte
// ranges in place with a fresh per-install key, without repacking.
import asarPkg from '@electron/asar';
import { readFileSync, writeFileSync, existsSync, rmSync, openSync, readSync, closeSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomFillSync, createHash } from 'node:crypto';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const { createPackage, getRawHeader, extractAll } = asarPkg;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const ASAR = join(REPO, 'resources', 'app.asar');

const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// --plain: stop after padding + manifest. This is what the release archive
// ships: entries carry the reserved 32-byte prefix as plaintext, and the
// installer encrypts them in place with a fresh per-install key
// (resources/protect-core.mjs). Without --plain the build also encrypts with
// the development key, which is how the lab verifies the boot path.
const PLAIN = process.argv.includes('--plain');
const EXTRACT = resolve(ARGS[0] || (process.env.TEMP + '/core-extract'));
const OUT = resolve(ARGS[1] || (process.env.TEMP + '/app.enc.asar'));
const KEYFILE = resolve(ARGS[2] || (process.env.TEMP + '/core-test.key'));

// Entries that carry the reserved 32-byte prefix and are encrypted.
const ENCRYPT = [
  'electron/main.jsc',
  'electron/services/knockdesk-bridge.js',
  'electron/services/knockdesk-plugin.js',
  'electron/main/bootstrap/knockdesk-bootstrap.js',
  'electron/main/ipc/knockdesk-remote-handlers.js',
  'electron/services/hermes-manager.js',
  'electron/services/computer-manager.js',
  'electron/services/cdp-shim.js',
];

// Entries whose SHA-256 is announced as protected in the manifest. The
// entries above are additionally encrypted; the rest are hashed only.
const PROTECTED_ALL = [
  '/electron/main.jsc',
  '/electron/main.js',
  '/electron/services/knockdesk-bridge.js',
  '/electron/services/knockdesk-plugin.js',
  '/electron/main/bootstrap/knockdesk-bootstrap.js',
  '/electron/main/ipc/knockdesk-remote-handlers.js',
  '/electron/services/hermes-manager.js',
  '/electron/services/computer-manager.js',
  '/electron/services/cdp-shim.js',
  '/electron/services/agenttown-manager.js',
  '/electron/services/telemetry.js',
  '/dist/idle-throttle.js',
  '/dist/storage-migration.js',
  '/dist/index.html',
];

const PREFIX = 32;
const MAGIC = Buffer.from('KD01', 'ascii');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const isEncrypted = (b) => b && b.length >= PREFIX && b.subarray(0, 4).equals(MAGIC);
const hasZeroPrefix = (b) => {
  if (!b || b.length < PREFIX) return false;
  for (let i = 0; i < PREFIX; i++) if (b[i] !== 0) return false;
  return true;
};

console.log('1/7 extracting', ASAR);
rmSync(EXTRACT, { recursive: true, force: true });
mkdirSync(EXTRACT, { recursive: true });
await extractAll(ASAR, EXTRACT);

console.log('2/7 refreshing the loader');
writeFileSync(join(EXTRACT, 'electron', 'main.js'),
  readFileSync(join(REPO, 'scripts', 'rebrand', 'launch-shim.js')));

console.log('3/7 reserving the 32-byte prefix on the protected core');
for (const rel of ENCRYPT) {
  const p = join(EXTRACT, rel.split('/').join('\\'));
  if (!existsSync(p)) { console.error('   MISSING', rel); process.exit(1); }
  const plain = readFileSync(p);
  if (hasZeroPrefix(plain) || isEncrypted(plain)) {
    console.error('   already prefixed (rerun without cleaning?):', rel);
    process.exit(1);
  }
  writeFileSync(p, Buffer.concat([Buffer.alloc(PREFIX), plain]), { mode: 0o600 });
  console.log('   ' + rel.padEnd(52) + String(plain.length).padStart(10) + ' -> '
    + String(plain.length + PREFIX).padStart(10) + ' B + prefix');
}

console.log('4/7 building the integrity manifest over the final layout');
const entries = {};
let protectedCount = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) { walk(full); continue; }
    const rel = relative(EXTRACT, full).replace(/\\/g, '/');
    if (rel === 'electron/integrity-manifest.json') continue;
    let bytes = readFileSync(full);
    if (ENCRYPT.includes(rel)) {
      if (!hasZeroPrefix(bytes)) { console.error('   missing prefix:', rel); process.exit(1); }
      bytes = bytes.subarray(PREFIX);
    }
    entries['/' + rel] = { size: bytes.length, sha256: sha(bytes) };
  }
};
walk(EXTRACT);
for (const p of PROTECTED_ALL) if (entries[p]) protectedCount++;
writeFileSync(join(EXTRACT, 'electron', 'integrity-manifest.json'), JSON.stringify({
  note: 'Integrity manifest for the KnockDesk protected core. Tamper-evident, not tamper-proof: without Authenticode signing of the installer this can be regenerated. See docs/ops/signing.md.',
  protected_entries: PROTECTED_ALL,
  protected_entry_count: protectedCount,
  total_entries: Object.keys(entries).length,
  algorithm: 'sha256',
  entries,
}, null, 1));
console.log('   manifest:', Object.keys(entries).length, 'entries,',
  protectedCount + '/' + PROTECTED_ALL.length, 'protected');
if (protectedCount !== PROTECTED_ALL.length) {
  console.error('   FAIL: not every protected entry is present; missing:',
    PROTECTED_ALL.filter((p) => !entries[p]));
  process.exit(1);
}

let key = null;
if (PLAIN) {
  console.log('5/7 plaintext build: keeping the reserved prefix, no encryption');
} else {
  console.log('5/7 encrypting the protected core (AES-256-GCM)');
  key = existsSync(KEYFILE) ? readFileSync(KEYFILE) : null;
  if (!key) {
    key = Buffer.alloc(32);
    randomFillSync(key);
    writeFileSync(KEYFILE, key, { mode: 0o600 });
    console.log('   generated a fresh key at', KEYFILE);
  }
  if (key.length !== 32) { console.error('   key must be 32 bytes, got', key.length); process.exit(1); }
  for (const rel of ENCRYPT) {
    const p = join(EXTRACT, rel.split('/').join('\\'));
    const padded = readFileSync(p);
    const iv = Buffer.alloc(12);
    randomFillSync(iv);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([c.update(padded.subarray(PREFIX)), c.final()]);
    const blob = Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
    if (blob.length !== padded.length) { console.error('   length drift:', rel); process.exit(1); }
    writeFileSync(p, blob, { mode: 0o600 });
    console.log('   ' + rel.padEnd(52) + 'encrypted in place,'
      + ' ' + String(blob.length).padStart(10) + ' B');
  }
}

console.log('6/7 repacking');
rmSync(OUT, { force: true });
await createPackage(EXTRACT, OUT);
console.log('   packed:', statSync(OUT).size, 'bytes');

console.log('7/7 verifying the ' + (PLAIN ? 'plaintext-padded' : 'encrypted') + ' archive');
const { header, headerSize } = getRawHeader(OUT, false);
const fd = openSync(OUT, 'r');
const readEntry = (node) => {
  const start = 8 + headerSize + parseInt(node.offset, 10);
  const buf = Buffer.alloc(node.size);
  readSync(fd, buf, 0, node.size, start);
  return buf;
};
const index = new Map();
const collect = (node, prefix) => {
  if (!node.files) { index.set(prefix, node); return; }
  for (const [k, v] of Object.entries(node.files)) collect(v, prefix + '/' + k);
};
collect(header, '');
let bad = 0;
for (const rel of ENCRYPT) {
  const node = index.get('/' + rel);
  if (!node) { console.error('   FAIL: missing', rel); bad++; continue; }
  const bytes = readEntry(node);
  if (PLAIN) {
    if (!hasZeroPrefix(bytes)) { console.error('   FAIL: reserved prefix missing:', rel); bad++; continue; }
    if (sha(bytes.subarray(PREFIX)) !== entries['/' + rel].sha256) {
      console.error('   FAIL: payload hash mismatch:', rel); bad++;
    }
  } else {
    if (!isEncrypted(bytes)) { console.error('   FAIL: not ciphertext:', rel); bad++; continue; }
    const d = createDecipheriv('aes-256-gcm', key, bytes.subarray(4, 16));
    d.setAuthTag(bytes.subarray(16, 32));
    const plain = Buffer.concat([d.update(bytes.subarray(PREFIX)), d.final()]);
    if (sha(plain) !== entries['/' + rel].sha256) {
      console.error('   FAIL: round-trip hash mismatch:', rel); bad++;
    }
  }
}
for (const p of index.keys()) {
  if (p.endsWith('.enc') || p.endsWith('.plain')) {
    console.error('   FAIL: build artifact left in the archive:', p); bad++;
  }
}
closeSync(fd);
if (bad) { console.error('FAIL:', bad, 'verification problem(s)'); process.exit(1); }
console.log('   all', ENCRYPT.length, 'entries',
  PLAIN ? 'carry the reserved prefix and hash to the manifest' : 'are ciphertext and decrypt back to the manifest hash');
console.log('DONE', OUT);
