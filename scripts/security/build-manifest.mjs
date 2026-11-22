// Build the integrity manifest for the protected core.
//
// Hashes every entry of the shipped asar into
// electron/integrity-manifest.json, which ships inside the archive so the
// runtime can verify itself after install. The manifest is tamper-evident,
// not tamper-proof: an attacker who can rewrite the archive can rewrite the
// manifest too. Prevention needs Authenticode signing of the installer and
// executable (see docs/ops/signing.md); this makes modification detectable
// and recoverable, which is what it can honestly claim.
//
// Usage: node scripts/security/build-manifest.mjs <extractDir> <asarPath> <outPath>
import { getRawHeader, listPackage } from '@electron/asar';
import { openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const EXTRACT = resolve(process.argv[2]);
const ASAR = resolve(process.argv[3]);
const OUT = resolve(process.argv[4] || (EXTRACT + '/electron/integrity-manifest.json'));

if (!EXTRACT || !ASAR) {
  console.error('usage: node build-manifest.mjs <extractDir> <asarPath> [outPath]');
  process.exit(2);
}

// The protected core: entries whose compromise would break a runtime
// contract, and which therefore must hash-match. Non-listed entries are
// verified best-effort and only reported.
const PROTECTED = [
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

const { header, headerSize } = getRawHeader(ASAR, false);
const fd = openSync(ASAR, 'r');
const readEntry = (node) => {
  const start = 8 + headerSize + parseInt(node.offset, 10);
  const buf = Buffer.alloc(node.size);
  readSync(fd, buf, 0, node.size, start);
  return buf;
};

// walk to (path -> node)
const map = new Map();
const walk = (node, prefix) => {
  if (!node.files) { map.set(prefix, node); return; }
  for (const [name, child] of Object.entries(node.files)) walk(child, prefix + '/' + name);
};
walk(header, '');

const entries = {};
let protectedCount = 0;
for (const [path, node] of map) {
  if (!node.size && node.size !== 0) continue;
  const buf = readEntry(node);
  entries[path] = { size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
  if (PROTECTED.includes(path)) protectedCount++;
}
closeSync(fd);

const manifest = {
  note: 'Integrity manifest for the KnockDesk protected core. Tamper-evident, not tamper-proof: without Authenticode signing of the installer this can be regenerated. See docs/ops/signing.md.',
  protected_entries: PROTECTED,
  protected_entry_count: protectedCount,
  total_entries: Object.keys(entries).length,
  algorithm: 'sha256',
  entries,
};

writeFileSync(OUT, JSON.stringify(manifest, null, 1));
console.log('manifest written:', OUT);
console.log('  entries:', manifest.total_entries, '| protected:', protectedCount, '/', PROTECTED.length);
const missing = PROTECTED.filter((p) => !entries[p]);
if (missing.length) { console.error('WARN protected entries not found in archive:', missing); }
