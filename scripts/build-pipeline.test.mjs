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
  assert.match(preload, /'knockdesk:memory:update',\s*String\(instruction \?\? ''\)\.trim\(\)/);
  assert.ok(main.includes("typeof instruction !== 'string'"));
  assert.ok(!preload.includes("'knockdesk:memory:update', {\n    instruction:"));
});

test('memory update re-attempts service initialization and returns a typed fallback on failure', () => {
  const main = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/main.ts'), 'utf8');
  const start = main.indexOf("ipcMain.handle('knockdesk:memory:update'");
  const end = main.indexOf("ipcMain.handle('knockdesk:system:info'", start);
  assert.ok(start >= 0 && end > start, 'memory update IPC handler must exist');
  const handler = main.slice(start, end);
  assert.match(handler, /const initialized = await initializeServicesForIpc\(\)/);
  assert.match(handler, /if \(!initialized \|\| !hermesManager\) \{\s*return \{ ok: false, error: 'Hermes could not be initialized\.' \};\s*\}/);
});

test('memory IPC length validation matches the runtime limit and never silently truncates accepted input', () => {
  const main = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/main.ts'), 'utf8');
  const runtime = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/services/desktop-hermes-runtime.js'), 'utf8');
  assert.match(main, /if \(instruction\.length > 1500\)/);
  assert.ok(main.includes('Memory instructions must be 1,500 characters or fewer.'));
  assert.match(runtime, /String\(instruction \|\| ''\)\.trim\(\)\.slice\(0, 1500\)/);
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

test('IPC initialization failures return channel-specific fallback payloads without masking runtime start errors', () => {
  const main = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/main.ts'), 'utf8');
  assert.equal((main.match(/await initializeServicesForIpc\(\)/g) || []).length, 4);
  assert.match(main, /async function initializeServicesForIpc\(\): Promise<boolean> \{[\s\S]*?try \{\s*await initializeServices\(window\);\s*return true;\s*\} catch \(error: unknown\) \{[\s\S]*?return false;/);
  assert.ok(main.includes("stateFallback('error', 'AgentTown could not be initialized.')"));
  assert.ok(main.includes("stateFallback('error', 'The Hermes runtime could not be initialized.')"));
  assert.ok(main.includes("return { available: false, memory: '', user: '' }"));
  // Manager start errors must continue to propagate rather than being converted
  // into a misleading "initialization failed" state.
  assert.ok(main.includes('return hermesManager.start();'));
  assert.ok(main.includes('return agentTownManager.start();'));
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
  assert.ok(build.includes("'services/retryable-initializer.js'"));
  assert.ok(build.includes("'services/child-process-tree.js'"));
});

test('runtime startup cannot spawn or mark ready after shutdown begins', () => {
  const hermes = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/services/desktop-hermes-runtime.js'), 'utf8');
  const agentTown = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/services/desktop-agenttown-runtime.js'), 'utf8');
  assert.match(hermes, /const firstProbe = await this\._probe\(\)\.catch\(\(\) => null\);\s*if \(this\.stopping\)/);
  assert.match(hermes, /const status = await this\._probe\(\)\.catch\(\(\) => null\);\s*if \(this\.stopping\)/);
  assert.match(agentTown, /const adopted = await probe\(this\.baseUrl\)\.catch\(\(\) => null\);\s*if \(this\.stopping\)/);
  assert.match(agentTown, /const available = await isPortAvailable\(candidate\);\s*if \(this\.stopping\)/);
  assert.match(agentTown, /const ready = await probe\(this\.baseUrl\)\.catch\(\(\) => null\);\s*if \(this\.stopping\)/);
});

test('memory UI reports success only when IPC explicitly returns ok=true', () => {
  const ui = readFileSync(resolve(root, 'resources/hermes-runtime/src/web/src/desktop/KnockDeskApp.tsx'), 'utf8');
  assert.ok(ui.includes('if (!result || result.ok !== true)'));
  assert.ok(ui.includes('The secure desktop bridge did not confirm a memory update.'));
});

test('shutdown waits for owned runtime and one-shot memory processes to exit', () => {
  const hermes = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/services/desktop-hermes-runtime.js'), 'utf8');
  const agentTown = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/services/desktop-agenttown-runtime.js'), 'utf8');
  assert.ok(hermes.includes('const memoryChildren = [...this.memoryChildren]'));
  assert.ok(hermes.includes('...memoryChildren.map((child) => stopOwnedChild(child, 2500, {'));
  assert.ok(hermes.includes('const pendingStart = this.startPromise'));
  assert.ok(agentTown.includes('await Promise.allSettled(['));
  assert.ok(agentTown.includes("stopOwnedChild(ownedChild, 2500, { detachedGroup: process.platform !== 'win32' })"));
});

test('Windows and macOS source smoke paths wait for the built desktop.html renderer', () => {
  const smoke = readFileSync(resolve(root, 'scripts/source_desktop_smoke_test.py'), 'utf8');
  assert.ok(smoke.includes('ELECTRON_APP / "dist" / "renderer" / "desktop.html"'));
  assert.ok(smoke.includes('elif sys.platform == "darwin"'));
  assert.ok(smoke.includes('"renderer/desktop.html" in candidate.url'));
  assert.ok(smoke.includes('start_new_session=os.name != "nt"'));
  assert.ok(smoke.includes('os.killpg(group_id, signal.SIGTERM)'));
  assert.ok(smoke.includes('os.killpg(group_id, signal.SIGKILL)'));
  assert.equal(smoke.includes('"renderer/index.html" in candidate.url'), false);
});


test('Windows smoke test scopes repeated navigation labels to its landmark', () => {
  const smoke = readFileSync(resolve(root, 'scripts/source_desktop_smoke_test.py'), 'utf8');
  assert.ok(smoke.includes('page.get_by_role("navigation", name="Main navigation")'));
  assert.ok(smoke.includes('navigation.get_by_role("button", name="System health").click()'));
  assert.equal(smoke.includes('page.get_by_role("button", name="System health").click()'), false);
});

test('source runtime accepts KnockDesk environment names and retains legacy aliases', () => {
  const hermes = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/services/hermes-runtime.js'), 'utf8');
  const agentTown = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/services/desktop-agenttown-runtime.js'), 'utf8');
  assert.ok(hermes.includes('process.env.KNOCKDESK_HERMES_EXE || process.env.STONIC_HERMES_EXE'));
  assert.ok(agentTown.includes('process.env.KNOCKDESK_AGENTTOWN_DIR'));
  assert.ok(agentTown.includes('process.env.STONIC_AGENTTOWN_DIR'));
});


test('development and Windows smoke flows install the Electron 44 binary on demand', () => {
  const dev = readFileSync(resolve(root, 'scripts/dev-knockdesk.mjs'), 'utf8');
  const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  assert.ok(dev.includes("'install-electron', '--no'"));
  assert.ok(ci.includes('npm exec --workspace electron -- install-electron --no'));
});

test('failed first-run initialization clears the cached promise so the user can retry', () => {
  const main = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/main.ts'), 'utf8');
  assert.match(main, /createRetryableInitializer/);
  assert.match(main, /initializeServicesOnceWithRetry\(window\)/);
});

test('retryable initializer deduplicates concurrent startup requests', async () => {
  const { createRetryableInitializer } = createRequire(import.meta.url)(resolve(
    root, 'resources/hermes-runtime/src/electron/services/retryable-initializer.js'
  ));
  let release;
  let calls = 0;
  const initializer = createRetryableInitializer(() => {
    calls += 1;
    return new Promise((resolve) => { release = resolve; });
  });

  const first = initializer();
  const second = initializer();
  assert.equal(first, second, 'concurrent callers should share the same promise');
  await Promise.resolve();
  assert.equal(calls, 1, 'only one initialization attempt should start');
  release('ready');
  assert.equal(await first, 'ready');
  assert.equal(await initializer(), 'ready', 'successful initialization remains cached');
  assert.equal(calls, 1, 'successful initialization must not run twice');
});

test('retryable initializer permits a new attempt after rejection', async () => {
  const { createRetryableInitializer } = createRequire(import.meta.url)(resolve(
    root, 'resources/hermes-runtime/src/electron/services/retryable-initializer.js'
  ));
  let calls = 0;
  const initializer = createRetryableInitializer(async () => {
    calls += 1;
    if (calls === 1) throw new Error('transient setup failure');
    return 'ready';
  });

  await assert.rejects(initializer(), /transient setup failure/);
  assert.equal(await initializer(), 'ready');
  assert.equal(calls, 2, 'second call should rerun the failed initialization');
});

test('retryable initializer rejects a missing callback clearly', () => {
  const { createRetryableInitializer } = createRequire(import.meta.url)(resolve(
    root, 'resources/hermes-runtime/src/electron/services/retryable-initializer.js'
  ));
  assert.throws(() => createRetryableInitializer(null), /initialize must be a function/);
});

test('startup stops with a clear error when the KnockDesk data directory cannot be initialized', () => {
  const main = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/main.ts'), 'utf8');
  assert.match(main, /const dataDirectory = ensureKnockDeskDirectories\(app\);/);
  assert.match(main, /if \(!dataDirectory\)/);
  assert.match(main, /Check that your Documents folder is writable, then retry/);
});

test('Hermes background startup errors clear the pending promise and can be retried', async () => {
  const { DesktopHermesRuntime } = createRequire(import.meta.url)(resolve(
    root, 'resources/hermes-runtime/src/electron/services/desktop-hermes-runtime.js'
  ));
  const runtime = new DesktopHermesRuntime();
  let attempts = 0;
  runtime._startBackground = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient Hermes startup failure');
    runtime._setState('ready');
  };

  const firstStart = runtime.start();
  const firstAttempt = runtime.startPromise;
  await Promise.resolve(firstAttempt).catch(() => undefined);
  await firstStart;
  assert.equal(runtime.getState().state, 'error', 'a rejected background start must surface an error state');
  assert.match(runtime.getState().error, /Hermes startup failed: transient Hermes startup failure/);
  assert.equal(runtime.startPromise, null, 'a failed background start must release the retry lock');

  await runtime.start();
  await runtime.startPromise;
  assert.equal(attempts, 2, 'the next start request must attempt launch again');
  assert.equal(runtime.getState().state, 'ready');
});

test('native title-bar overlay is configured only on platforms that need custom window controls', () => {
  const main = readFileSync(resolve(root, 'resources/hermes-runtime/src/electron/main.ts'), 'utf8');
  assert.match(main, /\.\.\.\(process\.platform !== 'darwin' \? \{/);
  assert.match(main, /titleBarOverlay:\s*\{/);
});

test('AgentTown background startup errors clear the pending promise and can be retried', async () => {
  const { DesktopAgentTownRuntime } = createRequire(import.meta.url)(resolve(
    root, 'resources/hermes-runtime/src/electron/services/desktop-agenttown-runtime.js'
  ));
  const runtime = new DesktopAgentTownRuntime();
  let attempts = 0;
  runtime._startBackground = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient AgentTown startup failure');
    runtime._setState('ready');
  };

  const firstStart = runtime.start();
  const firstAttempt = runtime.startPromise;
  await Promise.resolve(firstAttempt).catch(() => undefined);
  await firstStart;
  assert.equal(runtime.getState().state, 'error', 'a rejected background start must surface an error state');
  assert.equal(runtime.startPromise, null, 'a failed background start must release the retry lock');

  await runtime.start();
  await runtime.startPromise;
  assert.equal(attempts, 2, 'the next start request must attempt launch again');
  assert.equal(runtime.getState().state, 'ready');
});

test('Windows required CI status-check name remains stable with a separate macOS smoke job', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /name:\s*\$\{\{\s*matrix\.name\s*\}\}/);
  assert.match(workflow, /os:\s*windows-latest[\s\S]*?name:\s*Windows desktop renderer smoke test/);
  assert.match(workflow, /os:\s*macos-latest[\s\S]*?name:\s*macOS desktop renderer smoke test/);
});
test('CodeQL workflow does not persist its checkout token', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/codeql.yml'), 'utf8');
  assert.match(workflow, /uses: actions\/checkout@v4\s+with:\s+lfs: false\s+persist-credentials: false/);
});

test('Hermes shutdown terminates the owned process tree instead of leaving a Python child behind', () => {
  const { terminateOwnedProcessTree } = createRequire(import.meta.url)(resolve(
    root, 'resources/hermes-runtime/src/electron/services/child-process-tree.js'
  ));
  assert.equal(typeof terminateOwnedProcessTree, 'function');

  const windowsCalls = [];
  let windowsChildKilled = false;
  const windowsChild = { pid: 1234, exitCode: null, kill: () => { windowsChildKilled = true; } };
  const spawnedKiller = { once() { return this; } };
  assert.equal(terminateOwnedProcessTree(windowsChild, {
    platform: 'win32',
    spawnProcess: (...args) => { windowsCalls.push(args); return spawnedKiller; },
  }), true);
  assert.deepEqual(windowsCalls[0].slice(0, 2), ['taskkill.exe', ['/PID', '1234', '/T', '/F']]);
  assert.equal(windowsCalls[0][2].windowsHide, true);
  assert.equal(windowsChildKilled, false, 'use taskkill /T so the launcher does not orphan its interpreter');

  const posixCalls = [];
  let posixChildKilled = false;
  const posixChild = { pid: 5678, exitCode: null, kill: () => { posixChildKilled = true; } };
  assert.equal(terminateOwnedProcessTree(posixChild, {
    platform: 'darwin',
    detachedGroup: true,
    killProcess: (pid, signal) => posixCalls.push([pid, signal]),
  }), true);
  assert.deepEqual(posixCalls, [[-5678, 'SIGKILL']], 'terminate the isolated process group on POSIX');
  assert.equal(posixChildKilled, false);
});
