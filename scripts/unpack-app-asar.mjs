#!/usr/bin/env node
/**
 * ASAR inspection helper. Never writes to resources/app.asar.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archive = join(root, 'resources', 'app.asar');
const defaultExtract = join(root, 'resources', 'app.asar.extracted');
const defaultRepack = join(root, 'resources', 'app.rebuilt.asar');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function usage() {
  console.log([
    'KnockDesk ASAR helper',
    '',
    'Commands:',
    '  node scripts/unpack-app-asar.mjs --list',
    '  node scripts/unpack-app-asar.mjs --extract [destination] [--force]',
    '  node scripts/unpack-app-asar.mjs --pack [source-directory] [output.asar] [--force]',
    '',
    'Defaults:',
    '  extraction: resources/app.asar.extracted/',
    '  pack output: resources/app.rebuilt.asar',
    '',
    'The original resources/app.asar is never overwritten.',
    'Run git lfs pull before listing or extracting packaged assets.',
  ].join('\n'));
}

function assertWithinRepository(value, label) {
  const destination = resolve(root, value);
  const rel = relative(root, destination);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error(label + ' must be a child of the repository root.');
  }
  if (destination === archive) {
    throw new Error('Refusing to operate on the original ASAR path.');
  }
  return destination;
}

function assertRealArchive() {
  if (!existsSync(archive)) throw new Error('Missing resources/app.asar. Run git lfs pull first.');
  const fd = openSync(archive, 'r');
  const prefix = Buffer.alloc(80);
  let bytesRead = 0;
  try {
    bytesRead = readSync(fd, prefix, 0, prefix.length, 0);
  } finally {
    closeSync(fd);
  }
  if (prefix.subarray(0, bytesRead).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) {
    throw new Error('resources/app.asar is still a Git LFS pointer. Run git lfs pull.');
  }
}

function runAsar(args) {
  console.log('>', npx, '--yes asar', args.join(' '));
  execFileSync(npx, ['--yes', 'asar', ...args], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.length === 0) {
  usage();
  process.exit(0);
}
const command = args[0];
const force = args.includes('--force');
const positional = args.slice(1).filter((arg) => arg !== '--force');

try {
  if (command === '--list') {
    assertRealArchive();
    runAsar(['list', archive]);
  } else if (command === '--extract') {
    assertRealArchive();
    const destination = positional[0]
      ? assertWithinRepository(positional[0], 'Extraction destination')
      : defaultExtract;
    if (existsSync(destination)) {
      if (!force) throw new Error('Destination already exists. Use --force to replace the extraction.');
      rmSync(destination, { recursive: true, force: true });
    }
    mkdirSync(dirname(destination), { recursive: true });
    runAsar(['extract', archive, destination]);
    console.log('Extracted to:', relative(root, destination));
    console.log('Use maintained source for durable changes; see docs/BUILD_AND_SOURCE_MAP.md.');
  } else if (command === '--pack') {
    const source = positional[0]
      ? assertWithinRepository(positional[0], 'Source directory')
      : defaultExtract;
    const output = positional[1]
      ? assertWithinRepository(positional[1], 'Repack output')
      : defaultRepack;
    if (!existsSync(source) || !lstatSync(source).isDirectory()) {
      throw new Error('Source directory is missing: ' + relative(root, source));
    }
    if (output === archive) throw new Error('Refusing to overwrite the original ASAR.');
    if (existsSync(output)) {
      if (!force) throw new Error('Output already exists. Use --force to replace it.');
      rmSync(output, { recursive: true, force: true });
    }
    mkdirSync(dirname(output), { recursive: true });
    runAsar(['pack', source, output]);
    console.log('Repacked inspection archive to:', relative(root, output));
    console.log('The original resources/app.asar was not modified.');
  } else {
    usage();
    throw new Error('Unknown command: ' + command);
  }
} catch (error) {
  console.error('[ASAR helper]', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
