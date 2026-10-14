import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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
  assert.ok(main.includes("path.join(__dirname, 'renderer', 'desktop.html')"));
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

test('Hermes command approval is on by default; unattended mode requires explicit opt-in', () => {
  const require = createRequire(import.meta.url);
  const { hermesSpawnEnv } = require(resolve(root, 'resources/hermes-runtime/src/electron/services/hermes-runtime.js'));
  const previousYolo = process.env.HERMES_YOLO_MODE;
  const previousOptIn = process.env.KNOCKDESK_ALLOW_UNAPPROVED_COMMANDS;
  try {
    delete process.env.HERMES_YOLO_MODE;
    delete process.env.KNOCKDESK_ALLOW_UNAPPROVED_COMMANDS;
    const safe = hermesSpawnEnv();
    assert.equal(Object.hasOwn(safe, 'HERMES_YOLO_MODE'), false);

    process.env.KNOCKDESK_ALLOW_UNAPPROVED_COMMANDS = '1';
    const optedIn = hermesSpawnEnv();
    assert.equal(optedIn.HERMES_YOLO_MODE, '1');
    assert.equal(Object.hasOwn(optedIn, 'KNOCKDESK_ALLOW_UNAPPROVED_COMMANDS'), false);
  } finally {
    if (previousYolo === undefined) delete process.env.HERMES_YOLO_MODE;
    else process.env.HERMES_YOLO_MODE = previousYolo;
    if (previousOptIn === undefined) delete process.env.KNOCKDESK_ALLOW_UNAPPROVED_COMMANDS;
    else process.env.KNOCKDESK_ALLOW_UNAPPROVED_COMMANDS = previousOptIn;
  }
});

test('source-owned Electron startup has no Axios dependency', () => {
  const main = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/main.ts'), 'utf8');
  assert.ok(main.includes('DesktopHermesRuntime'));
  assert.ok(main.includes('DesktopAgentTownRuntime'));
  assert.ok(!main.includes("services/hermes-manager.js"));
  assert.ok(!main.includes("services/agenttown-manager.js"));
  const build = readFileSync(script, 'utf8');
  for (const file of ['services/desktop-hermes-runtime.js', 'services/desktop-agenttown-runtime.js']) {
    assert.ok(build.includes(file), 'build must validate ' + file);
  }
});

test('dependency-free runtime controllers expose stable idle states without starting services', () => {
  const require = createRequire(import.meta.url);
  const { DesktopHermesRuntime } = require(resolve(root, 'resources/hermes-runtime/src/electron/services/desktop-hermes-runtime.js'));
  const { DesktopAgentTownRuntime } = require(resolve(root, 'resources/hermes-runtime/src/electron/services/desktop-agenttown-runtime.js'));
  const hermes = new DesktopHermesRuntime();
  const agentTown = new DesktopAgentTownRuntime();
  assert.equal(hermes.getState().state, 'idle');
  assert.equal(hermes.getState().port, 9119);
  assert.equal(agentTown.getState().state, 'idle');
  assert.equal(agentTown.getState().port, 3010);
  assert.equal(typeof hermes.readMemoryFiles().memory, 'string');
});

test('AgentTown rejects non-HTML or non-Next listeners and accepts real Next HTML', () => {
  const require = createRequire(import.meta.url);
  const { isAgentTownHtml } = require(resolve(root, 'resources/hermes-runtime/src/electron/services/desktop-agenttown-runtime.js'));
  assert.equal(isAgentTownHtml('text/html; charset=utf-8', '<!doctype html><html lang="en"><script src="/_next/static/app.js"></script>'), true);
  assert.equal(isAgentTownHtml('application/json', '{"ok":true}'), false);
  assert.equal(isAgentTownHtml('text/html', '<html lang="en"><title>Not a Next app</title></html>'), false);
});

test('build assertions and Electron entrypoint agree on the Vite desktop HTML name', () => {
  const build = readFileSync(script, 'utf8');
  const main = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/main.ts'), 'utf8');
  assert.ok(build.includes("'renderer/desktop.html'"));
  assert.equal(build.includes("'renderer/index.html'"), false);
  assert.ok(main.includes("path.join(__dirname, 'renderer', 'desktop.html')"));
  assert.ok(build.includes("main: 'dist/bootstrap.js'"));
  assert.ok(build.includes("join(stagedResources, 'agent-town-dist')"));
});

test('memory bridge payload matches the main-process string contract', () => {
  const preload = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/desktop-preload.js'), 'utf8');
  const main = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/main.ts'), 'utf8');
  assert.ok(preload.includes("String(instruction ?? '').trim()"));
  assert.ok(preload.includes("'knockdesk:memory:update',\n    String(instruction ?? '').trim()"));
  assert.ok(main.includes("typeof instruction !== 'string'"));
  assert.ok(!preload.includes("'knockdesk:memory:update', {\n    instruction:"));
});

test('ASAR helper documents safe list, extract and pack operations', () => {
  const helper = resolve(root, 'scripts/unpack-app-asar.mjs');
  const check = spawnSync(process.execPath, ['--check', helper], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const help = spawnSync(process.execPath, [helper, '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /original resources\/app\.asar is never overwritten/i);
});

test('desktop shutdown waits for child runtime cleanup before quitting', () => {
  const main = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/main.ts'), 'utf8');
  assert.ok(main.includes('event.preventDefault()'));
  assert.ok(main.includes('Promise.allSettled'));
  assert.ok(main.includes('hermesManager?.stop?.()'));
  assert.ok(main.includes('agentTownManager?.stop?.()'));
});

test('runtime and AgentTown start requests wait for first-run service initialization', () => {
  const main = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/main.ts'), 'utf8');
  assert.equal((main.match(/await initializeServicesForIpc\(\)/g) || []).length, 3);
  assert.ok(main.includes('async function initializeServicesForIpc(): Promise<boolean>'));
  assert.ok(main.includes("stateFallback('error', 'AgentTown could not be initialized.')"));
  assert.ok(main.includes("stateFallback('error', 'The Hermes runtime could not be initialized.')"));
});

test('manual ASAR extraction workflow exposes a downloadable artifact', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/unpack-asar.yml'), 'utf8');
  assert.ok(workflow.includes('workflow_dispatch:'));
  assert.ok(workflow.includes('npx --yes asar extract'));
  assert.ok(workflow.includes('actions/upload-artifact@v4'));
});

test('first-run setup installs every first-party plugin into the supplied Hermes home', () => {
  const require = createRequire(import.meta.url);
  const plugins = require(resolve(root, 'resources/hermes-runtime/src/electron/services/knockdesk-plugin.js'));
  const home = mkdtempSync(join(tmpdir(), 'knockdesk-plugin-test-'));
  try {
    const results = [
      plugins.ensureKnockDeskPlugin(home),
      plugins.ensureKnockDeskComputerPlugin(home),
      plugins.ensureKnockDeskMemoryPlugin(home),
    ];
    for (const result of results) assert.equal(result.ok, true, result.error);
    for (const relativePath of [
      'plugins/knockdesk/adapter.py',
      'plugins/knockdesk/activity.py',
      'plugins/knockdesk-computer/tool.py',
      'plugins/knockdesk-memory/__init__.py',
    ]) {
      assert.ok(existsSync(join(home, relativePath)), 'missing installed plugin file: ' + relativePath);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('staging bundles the plugin source used by its first-run installer', () => {
  const build = readFileSync(script, 'utf8');
  assert.ok(build.includes("join(stagedResources, 'hermes-plugins')"));
  assert.ok(build.includes("'knockdesk/plugin.yaml'"));
  assert.ok(build.includes("'knockdesk-computer/plugin.yaml'"));
  assert.ok(build.includes("'knockdesk-memory/plugin.yaml'"));
});

test('runtime startup cannot spawn or mark ready after shutdown begins', () => {
  const hermes = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/services/desktop-hermes-runtime.js'), 'utf8');
  const agentTown = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/services/desktop-agenttown-runtime.js'), 'utf8');
  assert.ok(hermes.includes('const firstProbe = await this._probe().catch(() => null);\n    if (this.stopping)'));
  assert.ok(hermes.includes('const status = await this._probe().catch(() => null);\n      if (this.stopping)'));
  assert.ok(agentTown.includes('const adopted = await probe(this.baseUrl).catch(() => null);\n    if (this.stopping)'));
  assert.ok(agentTown.includes('const available = await isPortAvailable(candidate);\n      if (this.stopping)'));
  assert.ok(agentTown.includes('const ready = await probe(this.baseUrl).catch(() => null);\n      if (this.stopping)'));
});

test('memory UI reports success only when IPC explicitly returns ok=true', () => {
  const ui = readFileSync(resolve(root, 'resources/hermes-runtime/src/web/src/desktop/KnockDeskApp.tsx'), 'utf8');
  assert.ok(ui.includes('if (!result || result.ok !== true)'));
  assert.ok(ui.includes('The secure desktop bridge did not confirm a memory update.'));
});
