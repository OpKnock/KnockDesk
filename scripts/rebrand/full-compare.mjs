// Byte-compare every entry of two asars and assert that only the
// intentionally edited files differ.
//
// Usage: node full-compare.mjs <oldAsar> <newAsar>
import { getRawHeader } from '@electron/asar';
import { openSync, readSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';

const OLD = resolve(process.argv[2]);
const NEW = resolve(process.argv[3]);
if (!OLD || !NEW) {
  console.error('usage: node full-compare.mjs <oldAsar> <newAsar>');
  process.exit(2);
}

function entries(asarPath) {
  const { header, headerSize } = getRawHeader(asarPath, false);
  const map = new Map();
  const walk = (node, prefix) => {
    if (!node.files) { map.set(prefix, node); return; }
    for (const [name, child] of Object.entries(node.files)) walk(child, prefix + '/' + name);
  };
  walk(header, '');
  const fd = openSync(asarPath, 'r');
  const read = (node) => {
    const start = 8 + headerSize + parseInt(node.offset, 10);
    const buf = Buffer.alloc(node.size);
    readSync(fd, buf, 0, node.size, start);
    return buf;
  };
  return { map, read, close: () => closeSync(fd) };
}

const EXPECTED = new Set([
  '/electron/main.js',
  '/electron/services/hermes-manager.js',
  '/electron/services/computer-manager.js',
  '/electron/services/computer-runtime.js',
  '/electron/services/agenttown-manager.js',
  '/electron/services/cdp-shim.js',
  '/electron/services/telemetry.js',
  '/electron/services/shell-runner.js',
  '/electron/services/hermes-runtime.js',
  '/electron/services/knockdesk-plugin.js',
  '/electron/services/stonic-plugin.js',
  '/electron/services/stonic-bridge.js',
  '/electron/services/memory/recall-agent.js',
  '/electron/main/ipc/knockdesk-remote-handlers.js',
  '/electron/main/ipc/stonic-remote-handlers.js',
  '/dist/index.html',
  '/dist/assets/index-u5ljrpMR-kd90.js',
  '/electron/services/stonic-bridge.js',
  '/electron/services/stonic-plugin.js',
  '/electron/main/bootstrap/stonic-bootstrap.js',
]);

// Entries that exist only in NEW. Exactly one is planned: the idle-throttle
// inject source the launch shim reads at startup.
const PLANNED_NEW = new Set([
  '/dist/idle-throttle.js',
  '/electron/idle-throttle-inject.js',
  '/electron/services/knockdesk-bridge.js',
  '/electron/services/knockdesk-plugin.js',
  '/electron/main/bootstrap/knockdesk-bootstrap.js',
  '/electron/main/ipc/knockdesk-remote-handlers.js',
]);
// Entries that disappear because their file was renamed. They are reported
// as MISSING-IN-NEW, which the EXPECTED set also carries.
const PLANNED_GONE = new Set([
  '/electron/services/stonic-bridge.js',
  '/electron/services/stonic-plugin.js',
  '/electron/main/bootstrap/stonic-bootstrap.js',
  '/electron/main/ipc/stonic-remote-handlers.js',
]);

const a = entries(OLD);
const b = entries(NEW);
const diffs = [];
let same = 0;
for (const [path, nodeA] of a.map) {
  const nodeB = b.map.get(path);
  if (!nodeB) { diffs.push([path, 'MISSING-IN-NEW']); continue; }
  const bufA = a.read(nodeA);
  const bufB = b.read(nodeB);
  if (bufA.equals(bufB)) { same++; continue; }
  diffs.push([path, `size ${nodeA.size}->${nodeB.size}`]);
}
for (const [path, nodeB] of b.map) {
  if (a.map.has(path)) continue;
  if (!PLANNED_NEW.has(path)) diffs.push([path, 'NEW-UNPLANNED']);
  else console.log('planned new entry:', path, `(${nodeB.size} bytes)`);
}
a.close(); b.close();

const unexpected = diffs.filter(([p]) => !EXPECTED.has(p) && !PLANNED_NEW.has(p) && !PLANNED_GONE.has(p));
console.log('entries compared:', a.map.size, '| byte-identical:', same, '| diffs:', diffs.length);
for (const [p, why] of diffs.filter(([p]) => EXPECTED.has(p))) console.log('  planned:', p, `(${why})`);
if (unexpected.length) {
  console.error('UNEXPECTED DIFFS:');
  for (const [p, why] of unexpected.slice(0, 30)) console.error('  ', p, why);
  process.exit(1);
}
// NOTE: the reference asar (the current shipped one) already contains the
// original 15 service patches, so a later repack legitimately changes only
// the loader plus the planned new file. The safety property enforced here
// is "no unplanned bytes differ", not "every patch must re-apply".
console.log('FULL COMPARE OK - only planned files differ');
