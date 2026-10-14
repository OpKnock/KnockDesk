#!/usr/bin/env node
/**
 * Start the source-owned KnockDesk desktop shell with one command.
 *
 * Installs the locked Electron/Web workspaces, compiles the main process,
 * starts Vite, waits for the desktop entry page, and launches Electron.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtimeRoot = join(repoRoot, 'resources/hermes-runtime/src');
const electronRoot = join(runtimeRoot, 'electron');
const webRoot = join(runtimeRoot, 'web');
const vendorModules = join(repoRoot, 'resources/app.asar.unpacked/node_modules');
const viteEntry = join(runtimeRoot, 'node_modules/vite/bin/vite.js');
const rendererUrl = 'http://127.0.0.1:5174/desktop.html';

function run(command, args, cwd) {
  console.log('>', command, args.join(' '));
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForRenderer(child) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('Vite exited before becoming ready (code ' + child.exitCode + ').');
    }
    try {
      const response = await fetch(rendererUrl, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      lastError = new Error('Vite returned HTTP ' + response.status);
    } catch (error) {
      lastError = error;
    }
    await sleep(300);
  }
  throw new Error('Timed out waiting for the desktop renderer: ' + String(lastError || 'no response'));
}

function stopChild(child) {
  if (child && child.exitCode === null && !child.killed) {
    try { child.kill(); } catch { /* process may already have exited */ }
  }
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 20) {
    throw new Error('KnockDesk development requires Node.js 20 or newer. Detected ' + process.versions.node);
  }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npm, ['ci', '--workspace', 'electron', '--workspace', 'web',
    '--include-workspace-root=false', '--no-audit'], runtimeRoot);
  run(npm, ['run', 'compile', '--workspace', 'electron'], runtimeRoot);

  if (!existsSync(viteEntry)) throw new Error('Vite binary is missing after npm ci: ' + viteEntry);
  const nodeRequire = createRequire(join(runtimeRoot, 'package.json'));
  const electronBinary = nodeRequire('electron');
  if (typeof electronBinary !== 'string' || !existsSync(electronBinary)) {
    throw new Error('Electron executable was not installed correctly: ' + String(electronBinary));
  }

  const nodePathParts = [
    vendorModules,
    join(runtimeRoot, 'node_modules'),
    process.env.NODE_PATH || '',
  ].filter(Boolean);
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    KNOCKDESK_RENDERER_URL: rendererUrl,
    KNOCKDESK_NODE_MODULES: vendorModules,
    NODE_PATH: nodePathParts.join(delimiter),
    STONIC_AGENTTOWN_DIR: join(repoRoot, 'resources/agent-town-dist'),
    STONIC_AGENTTOWN_BUNDLED: '1',
  };

  const hermesExe = join(repoRoot, 'resources/hermes-runtime',
    process.platform === 'win32' ? 'venv/Scripts/hermes.exe' : 'venv/bin/hermes');
  if (existsSync(hermesExe)) env.STONIC_HERMES_EXE = hermesExe;

  let vite;
  let electron;
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopChild(electron);
    stopChild(vite);
  };
  process.on('SIGINT', () => { shutdown(); });
  process.on('SIGTERM', () => { shutdown(); });

  try {
    vite = spawn(process.execPath, [viteEntry, '--config', 'vite.desktop.config.ts',
      '--host', '127.0.0.1', '--port', '5174', '--strictPort'], {
      cwd: webRoot, env, stdio: 'inherit', windowsHide: true,
    });
    await waitForRenderer(vite);

    console.log('Starting KnockDesk. Close the desktop window or press Ctrl+C to stop.');
    electron = spawn(electronBinary, [electronRoot], {
      cwd: electronRoot, env, stdio: 'inherit', windowsHide: false,
    });
    await new Promise((resolveExit, rejectExit) => {
      electron.once('error', rejectExit);
      electron.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
  } finally {
    shutdown();
  }
}

main().catch((error) => {
  console.error('[KnockDesk dev]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
