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

test('Electron loads the source-built KnockDesk shell and does not block on Hermes boot', () => {
  const paths = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/main/shared/paths.ts'), 'utf8');
  const main = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/main.ts'), 'utf8');
  assert.ok(paths.includes("path.resolve(__dirname, '../../preload.js')"));
  assert.ok(main.includes("path.join(__dirname, 'renderer', 'index.html')"));
  assert.ok(main.includes('webviewTag: true'));
  assert.ok(main.includes('void hermesManager.start()'));
  assert.ok(!main.includes('await hermesManager.start()'));
  assert.ok(!main.includes('manager.baseUrl'));
});

test('staging script includes CommonJS services', () => {
  const source = readFileSync(script, 'utf8');
  assert.ok(source.includes('copyMissingJs'));
  assert.ok(source.includes('services/hermes-manager.js'));
});

test('desktop renderer has its own stable output path', () => {
  const html = readFileSync(resolve(root, 'resources/hermes-runtime/src/web/desktop.html'), 'utf8');
  const vite = readFileSync(resolve(root, 'resources/hermes-runtime/src/web/vite.desktop.config.ts'), 'utf8');
  assert.ok(html.includes('/src/desktop/main.tsx'));
  assert.ok(vite.includes('../electron/dist/renderer'));
  assert.ok(vite.includes('desktop.html'));
});

test('desktop shell uses existing allowlisted IPC surfaces', () => {
  const app = readFileSync(resolve(root, 'resources/hermes-runtime/src/web/src/desktop/KnockDeskApp.tsx'), 'utf8');
  for (const api of ['getRuntimeState()', 'getHermesPreloadPath()', 'readMemory()', 'requestMemory(instruction)', 'getAgentTownState()']) {
    assert.ok(app.includes(api), 'missing typed bridge integration: ' + api);
  }
  const preload = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/desktop-preload.js'), 'utf8');
  assert.ok(preload.includes("exposeInMainWorld('knockdeskAPI'"));
  assert.ok(!preload.includes('electronAPI'));
});

test('runtime state keeps structured status instead of stringifying it', () => {
  const manager = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/services/hermes-manager.js'), 'utf8');
  assert.ok(manager.includes('status: this.lastStatus && typeof this.lastStatus === \'object\''));
  assert.ok(manager.includes('external: Boolean(this.external)'));
});
