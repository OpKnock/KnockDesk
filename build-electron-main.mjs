#!/usr/bin/env node
/**
 * Reproducible source build for the maintained KnockDesk Electron shell.
 *
 * This builds into resources/hermes-runtime/src/electron/dist and then stages
 * the source-built shell under staging/electron-main. Runtime sidecars must
 * also be packaged before this can be called a distributable. It never mutates the
 * existing packaged app.asar, main.jsc, or KnockDesk.exe.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const runtimeDir = join(root, 'resources/hermes-runtime/src');
const electronDir = join(runtimeDir, 'electron');
const webDir = join(runtimeDir, 'web');
const stagedDir = join(root, 'staging/electron-main');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(args, options = {}) {
  console.log('>', npm, args.join(' '));
  execFileSync(npm, args, {
    cwd: options.cwd ?? runtimeDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      // Build/type-check only: avoid downloading an Electron executable in CI.
      ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    },
  });
}

function copyMissingJs(sourceDir, targetDir) {
  if (!existsSync(sourceDir)) return;
  for (const item of readdirSync(sourceDir, { withFileTypes: true })) {
    const source = join(sourceDir, item.name);
    const target = join(targetDir, item.name);
    if (item.isDirectory()) {
      copyMissingJs(source, target);
    } else if (item.isFile() && item.name.endsWith('.js') && !existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target);
    }
  }
}

function assertExists(base, relativePaths) {
  for (const relativePath of relativePaths) {
    if (!existsSync(join(base, relativePath))) {
      throw new Error('Build output is incomplete; missing: ' + relativePath);
    }
  }
}

function main() {
  if (process.argv.includes('--dry-run')) {
    console.log('Workspace:', runtimeDir);
    console.log('Electron source:', electronDir);
    console.log('Desktop renderer source:', webDir);
    console.log('Staging destination:', stagedDir);
    console.log('Protected artifacts: resources/main.jsc, resources/app.asar, KnockDesk.exe');
    return;
  }

  // Both workspaces share the committed lockfile at runtimeDir/package-lock.json.
  // Run from the workspace root; npm invoked inside electron/ fails to resolve
  // the parent workspace graph. CI may install once and request --skip-install.
  if (!process.argv.includes('--skip-install')) {
    run(['ci', '--workspace', 'electron', '--workspace', 'web',
      '--include-workspace-root=false', '--no-audit']);
  }

  run(['run', 'compile', '--workspace', 'electron']);
  run(['run', 'build:desktop', '--workspace', 'web']);

  const dist = join(electronDir, 'dist');
  const pwaSource = join(electronDir, 'pwa');
  if (existsSync(pwaSource)) cpSync(pwaSource, join(dist, 'pwa'), { recursive: true, force: true });
  assertExists(dist, [
    'main.js',
    'bootstrap.js',
    'desktop-preload.js',
    'preload.js',
    'agenttown-preload.js',
    'hermes-preload.js',
    'main/ipc/index.js',
    'main/ipc/system-handlers.js',
    'main/shared/paths.js',
    'services/hermes-manager.js',
    'services/desktop-hermes-runtime.js',
    'services/desktop-agenttown-runtime.js',
    'renderer/index.html',
    'pwa/icon-512.png',
  ]);

  // Stage from a clean directory so deleted output cannot survive a rebuild.
  rmSync(stagedDir, { recursive: true, force: true });
  mkdirSync(stagedDir, { recursive: true });
  cpSync(dist, join(stagedDir, 'dist'), { recursive: true });

  // allowJs should emit these. Copying only absent files makes the staging
  // operation resilient to future tsconfig changes without overwriting output.
  for (const folder of ['main', 'services']) {
    copyMissingJs(join(electronDir, folder), join(stagedDir, 'dist', folder));
  }

  assertExists(join(stagedDir, 'dist'), [
    'main.js',
    'bootstrap.js',
    'desktop-preload.js',
    'preload.js',
    'agenttown-preload.js',
    'hermes-preload.js',
    'main/ipc/index.js',
    'main/ipc/system-handlers.js',
    'main/shared/paths.js',
    'services/hermes-manager.js',
    'renderer/index.html',
    'pwa/icon-512.png',
  ]);

  console.log('Staged Electron main, preloads, renderer and runtime modules:');
  console.log(resolve(stagedDir));
  console.log('Existing KnockDesk.exe, resources/main.jsc and resources/app.asar were not modified.');
  console.log('Staging is validated build output, not a signed release installer.');
}

main();
