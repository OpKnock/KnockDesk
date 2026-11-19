import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(root, 'build-electron-main.mjs');

test('Electron build script is valid Node JavaScript', () => {
  const check = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

test('dry run targets staging and preserves shipped artifacts', () => {
  const run = spawnSync(process.execPath, [script, '--dry-run'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /staging[/\\]electron-main/);
  assert.match(run.stdout, /resources[/\\]main\.jsc/);
  assert.match(run.stdout, /resources[/\\]app\.asar/);
});

test('build script never writes directly to production ASAR or bytecode', () => {
  const source = readFileSync(script, 'utf8');
  assert.doesNotMatch(source, /cpSync\([^\n]*resources[/\\]main\.jsc/);
  assert.doesNotMatch(source, /cpSync\([^\n]*resources[/\\]app\.asar/);
  assert.match(source, /staging\/electron-main/);
});
