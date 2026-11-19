#!/usr/bin/env node
/**
 * Build the maintained Electron TypeScript entrypoint into a separate staging
 * directory. Never replace the shipped app.asar or main.jsc from this script:
 * their feature parity with these sources has not yet been established.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const electronDir = join(root, 'resources/hermes-runtime/src/electron');
const stagedDir = join(root, 'staging/electron-main');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(...args) {
  console.log('>', npm, args.join(' '));
  execFileSync(npm, args, { cwd: electronDir, stdio: 'inherit' });
}

function copyRuntimeJs(sourceDir, targetDir) {
  if (!existsSync(sourceDir)) return;
  for (const item of readdirSync(sourceDir, { withFileTypes: true })) {
    const source = join(sourceDir, item.name);
    const target = join(targetDir, item.name);
    if (item.isDirectory()) {
      copyRuntimeJs(source, target);
    } else if (item.isFile() && item.name.endsWith('.js')) {
      // TypeScript compiled .ts siblings take precedence.
      if (!existsSync(target)) {
        mkdirSync(dirname(target), { recursive: true });
        cpSync(source, target);
      }
    }
  }
}

function main() {
  if (process.argv.includes('--dry-run')) {
    console.log('Electron source:', electronDir);
    console.log('Staging destination:', stagedDir);
    console.log('Protected artifacts: resources/main.jsc, resources/app.asar, KnockDesk.exe');
    return;
  }
  // This package currently has no package-lock.json; npm ci would fail.
  run('install', '--no-save', '--package-lock=false', '--no-audit');
  run('run', 'compile');
  const dist = join(electronDir, 'dist');
  const entry = join(dist, 'main.js');
  if (!existsSync(entry)) {
    throw new Error('Compilation did not produce dist/main.js');
  }

  // Never mix stale staged files into a fresh build.
  rmSync(stagedDir, { recursive: true, force: true });
  const stagedDist = join(stagedDir, 'dist');
  mkdirSync(stagedDir, { recursive: true });
  cpSync(dist, stagedDist, { recursive: true });
  // TypeScript emits its own files, but allowJs does not ensure every
  // hand-written CommonJS dependency is present. Copy missing JS siblings.
  for (const folder of ['main', 'services', 'pwa']) {
    copyRuntimeJs(join(electronDir, folder), join(stagedDist, folder));
  }
  for (const name of ['preload.js', 'agenttown-preload.js', 'hermes-preload.js']) {
    const source = join(electronDir, name);
    if (!existsSync(source)) throw new Error('Missing Electron preload: ' + name);
    cpSync(source, join(stagedDist, name));
  }
  for (const required of ['main.js', 'preload.js', 'main/ipc/index.js',
    'main/ipc/system-handlers.js', 'main/shared/paths.js',
    'services/hermes-manager.js']) {
    if (!existsSync(join(stagedDist, required))) {
      throw new Error('Incomplete staged Electron output: ' + required);
    }
  }

  console.log('Staged:', resolve(stagedDir));
  console.log('The shipped main.jsc, app.asar and executable were NOT modified.');
  console.log('This is a source-build check, NOT yet a production packaging step.');
}

main();
