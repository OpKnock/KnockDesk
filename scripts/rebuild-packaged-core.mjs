#!/usr/bin/env node
/**
 * Rebuild the protected core inside resources/app.asar from maintained source.
 *
 * The preserved Windows payload ships a plain-JS launch shim (main.js) that
 * requires the legacy bytecode (main.jsc). The bytecode still loads service
 * modules from the archive, so source fixes to those services and to the
 * bundled desktop version must be reflected in app.asar before an installer is
 * built. This script performs that overlay deterministically and regenerates
 * the archive's integrity manifest. It never edits the committed LFS payload;
 * it replaces the archive only on the build host that produces a release.
 *
 * Usage:
 *   node scripts/rebuild-packaged-core.mjs --dry-run
 *   node scripts/rebuild-packaged-core.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = path.join(ROOT, 'resources', 'app.asar');
const WORK = path.join(ROOT, 'staging', 'app-asar-rebuild');
const OUTPUT = path.join(ROOT, 'resources', 'app.rebuilt.asar');
const SERVICES = path.join(ROOT, 'resources', 'hermes-runtime', 'src', 'electron', 'services');

const VERSION = '3.1.13';
const OLD_VERSION = '3.1.12';
const VERSION_FILE = 'package.json';
const VERSION_BUNDLE = 'dist/assets/index-u5ljrpMR-kd90.js';

// Maintained source -> path inside app.asar. These are the service modules
// changed by the 3.1.13 fixes that the legacy bytecode still loads.
const OVERLAYS = [
  ['hermes-manager.js', 'electron/services/hermes-manager.js'],
  ['knockdesk-plugin.js', 'electron/services/knockdesk-plugin.js'],
  ['knockdesk-bridge.js', 'electron/services/knockdesk-bridge.js'],
  ['macos-updater.js', 'electron/services/macos-updater.js'],
];

const MANIFEST = 'electron/integrity-manifest.json';
const PROTECTED_PREFIX_BYTES = 32;
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function usage() {
  console.log('Packaged-core rebuild plan:');
  console.log(`  release version: ${VERSION}`);
  console.log(`  source archive: ${toPosix(path.relative(ROOT, ARCHIVE))}`);
  console.log(`  work directory: ${toPosix(path.relative(ROOT, WORK))}`);
  console.log(`  repack output:  ${toPosix(path.relative(ROOT, OUTPUT))}`);
  for (const [source, target] of OVERLAYS) {
    console.log(`  overlay: ${source} -> ${target}`);
  }
  console.log(`  version files: ${VERSION_FILE}, ${VERSION_BUNDLE}`);
  console.log(`  manifest: ${MANIFEST}`);
}

function assertRealArchive() {
  if (!fs.existsSync(ARCHIVE)) throw new Error(`Missing source archive: ${ARCHIVE}`);
  const fd = fs.openSync(ARCHIVE, 'r');
  const prefix = Buffer.alloc(80);
  let bytes = 0;
  try {
    bytes = fs.readSync(fd, prefix, 0, prefix.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (prefix.subarray(0, bytes).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) {
    throw new Error('resources/app.asar is an LFS pointer. Run git lfs pull first.');
  }
}

function runAsar(args) {
  execFileSync(npx, ['--yes', 'asar', ...args], {
    cwd: ROOT,
    stdio: args[0] === 'list' ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    shell: process.platform === 'win32',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function listArchive(archive) {
  const out = execFileSync(npx, ['--yes', 'asar', 'list', archive], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 16 * 1024 * 1024,
  });
  return new Set(out.split(/\r?\n/).map((line) => toPosix(line.trim()).replace(/^\/+/, '')).filter(Boolean));
}

function hasZeroPrefix(buffer, length) {
  if (buffer.length < length) return false;
  for (let i = 0; i < length; i += 1) {
    if (buffer[i] !== 0) return false;
  }
  return true;
}

function isEncrypted(buffer) {
  return buffer.length >= PROTECTED_PREFIX_BYTES
    && buffer[0] === 0x4b && buffer[1] === 0x44 && buffer[2] === 0x30 && buffer[3] === 0x31;
}

function replaceBytes(buffer, from, to) {
  if (from.length !== to.length) throw new Error('Byte replacement must preserve length.');
  const result = Buffer.from(buffer);
  let index = result.indexOf(from);
  let count = 0;
  while (index !== -1) {
    to.copy(result, index);
    count += 1;
    index = result.indexOf(from, index + to.length);
  }
  return { result, count };
}

function patchVersionFiles() {
  const jsonPath = path.join(WORK, VERSION_FILE);
  const json = fs.readFileSync(jsonPath, 'utf8');
  const patchedJson = json.replace(/("version"\s*:\s*")[^"]+(")/, `$1${VERSION}$2`);
  if (patchedJson === json) throw new Error(`Version field not found in ${VERSION_FILE}.`);
  fs.writeFileSync(jsonPath, patchedJson);

  const bundlePath = path.join(WORK, VERSION_BUNDLE);
  if (!fs.existsSync(bundlePath)) throw new Error(`Version bundle missing: ${VERSION_BUNDLE}.`);
  const { result, count } = replaceBytes(
    fs.readFileSync(bundlePath),
    Buffer.from(OLD_VERSION, 'utf8'),
    Buffer.from(VERSION, 'utf8'),
  );
  if (count === 0) throw new Error(`No ${OLD_VERSION} string found in ${VERSION_BUNDLE}.`);
  fs.writeFileSync(bundlePath, result);
  console.log(`Patched ${count} renderer version string in ${VERSION_BUNDLE}.`);
}

function overlayServices(protectedSet) {
  for (const [sourceName, targetRel] of OVERLAYS) {
    const source = path.join(SERVICES, sourceName);
    const target = path.join(WORK, ...targetRel.split('/'));
    if (!fs.existsSync(source)) throw new Error(`Maintained source missing: ${sourceName}`);
    if (!fs.existsSync(target)) throw new Error(`Archive target missing: ${targetRel}`);

    let payload = fs.readFileSync(source);
    if (protectedSet.has(targetRel)) {
      const original = fs.readFileSync(target);
      if (isEncrypted(original)) {
        throw new Error(`Cannot rebuild encrypted protected entry from plaintext source: ${targetRel}`);
      }
      if (hasZeroPrefix(original, PROTECTED_PREFIX_BYTES)) {
        payload = Buffer.concat([Buffer.alloc(PROTECTED_PREFIX_BYTES), payload]);
      }
    }
    fs.writeFileSync(target, payload);
    console.log(`Overlaid ${targetRel} (${payload.length} bytes).`);
  }
}

function walkFiles(directory, base = directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, found);
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

function regenerateManifest() {
  const manifestPath = path.join(WORK, MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const protectedEntries = Array.isArray(manifest.protected_entries) ? manifest.protected_entries : [];
  const protectedSet = new Set(protectedEntries.map((entry) => toPosix(String(entry)).replace(/^\/+/, '')));
  const entries = {};

  for (const file of walkFiles(WORK)) {
    const rel = toPosix(path.relative(WORK, file));
    if (rel === MANIFEST) continue;
    const bytes = fs.readFileSync(file);
    entries[`/${rel}`] = {
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  manifest.total_entries = Object.keys(entries).length;
  manifest.protected_entry_count = protectedEntries.length;
  manifest.entries = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
  return protectedSet;
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  if (process.argv.includes('--dry-run')) {
    usage();
    return;
  }

  assertRealArchive();
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.rmSync(OUTPUT, { force: true });
  fs.mkdirSync(WORK, { recursive: true });

  console.log('== extracting release archive ==');
  runAsar(['extract', ARCHIVE, WORK]);

  console.log('== refreshing integrity manifest source set ==');
  const initialManifest = JSON.parse(fs.readFileSync(path.join(WORK, MANIFEST), 'utf8'));
  const protectedEntries = Array.isArray(initialManifest.protected_entries) ? initialManifest.protected_entries : [];
  const protectedSet = new Set(protectedEntries.map((entry) => toPosix(String(entry)).replace(/^\/+/, '')));

  overlayServices(protectedSet);
  patchVersionFiles();
  regenerateManifest();

  console.log('== repacking archive ==');
  runAsar(['pack', WORK, OUTPUT]);

  const packedEntries = listArchive(OUTPUT);
  for (const [, targetRel] of OVERLAYS) {
    if (!packedEntries.has(targetRel)) throw new Error(`Repacked archive is missing ${targetRel}`);
  }
  for (const rel of [VERSION_FILE, VERSION_BUNDLE, MANIFEST]) {
    if (!packedEntries.has(rel)) throw new Error(`Repacked archive is missing ${rel}`);
  }

  const outputHash = await hashFile(OUTPUT);
  fs.copyFileSync(OUTPUT, ARCHIVE);
  const archiveHash = await hashFile(ARCHIVE);
  if (archiveHash !== outputHash) throw new Error('Rebuilt archive verification failed.');
  fs.rmSync(OUTPUT, { force: true });

  console.log(`Rebuilt ${toPosix(path.relative(ROOT, ARCHIVE))} for ${VERSION}.`);
  console.log(`SHA-256: ${archiveHash}`);
}

main().catch((error) => {
  console.error('[rebuild-packaged-core]', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
