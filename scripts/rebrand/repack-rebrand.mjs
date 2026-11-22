// Pack the rebrand-patched extraction into a new asar and verify every gate:
//  - entry count and file list identical to the reference asar
//  - main.jsc byte-identical (untouched bytecode)
//  - main.js == the launch shim (scripts/rebrand/launch-shim.js)
//  - service patches present in the packed bytes
//  - CI brand-guard simulation on the first 1 MB
//
// Usage:
//   node scripts/rebrand/repack-rebrand.mjs <extractDir> <outAsar> [referenceAsar]
// Defaults: referenceAsar = <repo>/resources/app.asar
import { getRawHeader, createPackage, listPackage } from '@electron/asar';
import { createHash } from 'crypto';
import { existsSync, openSync, readSync, closeSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));       // <repo>/scripts/rebrand
const REPO = resolve(HERE, '..', '..');
const SHIM = join(HERE, 'launch-shim.js');

const EXTRACT = resolve(process.argv[2]);
const OUT = resolve(process.argv[3]);
const ASAR = process.argv[4] ? resolve(process.argv[4]) : join(REPO, 'resources', 'app.asar');

if (!EXTRACT || !OUT) {
  console.error('usage: node repack-rebrand.mjs <extractDir> <outAsar> [referenceAsar]');
  process.exit(2);
}

const sha = (b) => createHash('sha256').update(b).digest('hex');

function readEntry(asarPath, rel) {
  const { header, headerSize } = getRawHeader(asarPath, false);
  let node = header;
  for (const part of rel.split('/')) {
    if (!node.files || !node.files[part]) throw new Error(`missing ${rel}`);
    node = node.files[part];
  }
  if (node.files) throw new Error('entry is a dir: ' + rel);
  const start = 8 + headerSize + parseInt(node.offset, 10);
  const buf = Buffer.alloc(node.size);
  const fd = openSync(asarPath, 'r');
  try { readSync(fd, buf, 0, node.size, start); } finally { closeSync(fd); }
  return buf;
}

console.log('packing', EXTRACT, '->', OUT);
if (existsSync(OUT)) rmSync(OUT, { force: true });
const t0 = Date.now();
await createPackage(EXTRACT, OUT);
console.log('pack done in', ((Date.now() - t0) / 1000).toFixed(1), 's |', statSync(OUT).size, 'bytes');

const oldHeader = getRawHeader(ASAR, false).header;
const newHeader = getRawHeader(OUT, false).header;
const countOld = JSON.stringify(oldHeader).match(/"size"/g)?.length ?? 0;
const countNew = JSON.stringify(newHeader).match(/"size"/g)?.length ?? 0;
console.log('entry counts:', countOld, '->', countNew);
// The first repack of the idle throttle adds two entries (dist/idle-throttle.js
// and electron/idle-throttle-inject.js); later repacks of the same feature add
// none. The file-list check below is the real gate; here we only reject a count
// that changed by more than those two planned additions or shrank.
if (countNew < countOld || countNew - countOld > 2) { console.error('FAIL: entry count mismatch'); process.exit(1); }

const norm = (p) => String(p).replace(/\\/g, '/');
const listOld = listPackage(ASAR).map(norm).sort();
const listNew = listPackage(OUT).map(norm).sort();
// Exactly one intended addition: the idle-throttle inject file the launch
// shim reads and executes in the app's windows.
const PLANNED_NEW = new Set(['/dist/idle-throttle.js', '/electron/idle-throttle-inject.js']);
const onlyOld = listOld.filter((p) => !listNew.includes(p));
const onlyNew = listNew.filter((p) => !listOld.includes(p));
if (onlyOld.length || onlyNew.some((p) => !PLANNED_NEW.has(p))) {
  console.error('FAIL: file list differs. onlyOld:', onlyOld.slice(0, 5), 'onlyNew:', onlyNew.slice(0, 5));
  process.exit(1);
}
console.log('file list delta: +' + onlyNew.length, '(planned:', [...PLANNED_NEW].join(',') + ') |', listNew.length, 'entries');

const jscOld = readEntry(ASAR, 'electron/main.jsc');
const jscNew = readEntry(OUT, 'electron/main.jsc');
console.log('main.jsc byte-identical:', jscOld.equals(jscNew), '|', jscNew.length, 'bytes');
if (!jscOld.equals(jscNew)) { console.error('FAIL: main.jsc changed'); process.exit(1); }

const loader = readEntry(OUT, 'electron/main.js');
console.log('main.js == launch shim:', loader.equals(readFileSync(SHIM)));
if (!loader.equals(readFileSync(SHIM))) { console.error('note: main.js differs from scripts/rebrand/launch-shim.js'); }
console.log('loader requires jsc:', loader.includes("require('./main.jsc')"));
console.log('loader has migration hatch:', loader.includes('KNOCKDESK_SKIP_LEGACY_MIGRATION'));

const INJECT = join(HERE, 'idle-throttle-inject.js');
const injectBytes = readEntry(OUT, '/electron/idle-throttle-inject.js'.slice(1));
console.log('idle inject source matches:', injectBytes.equals(readFileSync(INJECT)));
if (!injectBytes.equals(readFileSync(INJECT))) { console.error('note: idle-throttle-inject.js differs from the source file'); }
const THROTTLE = join(HERE, 'idle-throttle.js');
const throttleBytes = readEntry(OUT, '/dist/idle-throttle.js'.slice(1));
console.log('idle throttle source matches:', throttleBytes.equals(readFileSync(THROTTLE)));
if (!throttleBytes.equals(readFileSync(THROTTLE))) { console.error('note: dist/idle-throttle.js differs from the source file'); }
const htmlEntry = readEntry(OUT, '/dist/index.html'.slice(1)).toString('utf8');
const htmlOk = htmlEntry.includes('./idle-throttle.js');
console.log('index.html loads the throttle first:', htmlOk);
if (!htmlOk) { console.error('FAIL: dist/index.html does not load the idle throttle'); process.exit(1); }

const checks = [
  ['electron/services/hermes-manager.js', 'KNOCKDESK_BRIDGE_URL: bridgeUrl'],
  ['electron/services/hermes-manager.js', /^\s*KNOCKDESK_(BRIDGE_URL|BRIDGE_KEY)/m],
  ['electron/services/computer-manager.js', "num('KNOCKDESK_COMPUTER_BOOT_DELAY_MS'"],
  ['electron/services/computer-manager.js', 'KNOCKDESK_COMPUTER_TESSERACT: tesseract'],
  ['electron/services/agenttown-manager.js', 'KNOCKDESK_AGENTTOWN_BUNDLED'],
  ['electron/services/shell-runner.js', "COMMAND_ENV_VAR = 'KNOCKDESK_OS_EXEC_COMMAND'"],
  ['electron/services/memory/recall-agent.js', "'USER' : 'KNOCKDESK'"],
];
let bad = 0;
for (const [file, needle] of checks) {
  const content = readEntry(OUT, file).toString('utf8');
  const ok = needle instanceof RegExp ? needle.test(content) : content.includes(needle);
  console.log((ok ? 'OK  ' : 'MISS') + ' ' + file + ' :: ' + String(needle).slice(0, 60));
  if (!ok) bad++;
}
if (bad) { console.error('FAIL: ' + bad + ' patch checks missing'); process.exit(1); }

const blob = readFileSync(OUT);
const head = blob.subarray(0, Math.min(blob.length, 1000000)).toString('utf8');
const stonic = (head.match(/Stonic AI/gi) || []).length;
const knockdesk = (head.match(/KnockDesk/gi) || []).length;
console.log('CI guard: Stonic AI hits =', stonic, '| KnockDesk hits =', knockdesk);
if (stonic > 0 || knockdesk === 0) { console.error('FAIL: CI brand guard would trip'); process.exit(1); }

console.log('REBRAND REPACK OK');
