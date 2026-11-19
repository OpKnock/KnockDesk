#!/usr/bin/env node
/**
 * Build the maintained Electron TypeScript entrypoint into a separate staging
 * directory. Never replace the shipped app.asar or main.jsc from this script:
 * their feature parity with these sources has not yet been established.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
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

function main() {
  run('ci', '--no-audit');
  run('run', 'compile');
  const dist = join(electronDir, 'dist');
  const entry = join(dist, 'main.js');
  if (!existsSync(entry)) {
    throw new Error('Compilation did not produce dist/main.js');
  }

  // Compiled JS is staged with its relative imports intact.
  mkdirSync(stagedDir, { recursive: true });
  cpSync(dist, join(stagedDir, 'dist'), { recursive: true, force: true });
  for (const name of ['preload.js', 'agenttown-preload.js', 'hermes-preload.js']) {
    const source = join(electronDir, name);
    if (existsSync(source)) cpSync(source, join(stagedDir, name));
  }

  console.log('Staged:', resolve(stagedDir));
  console.log('The shipped main.jsc, app.asar and executable were NOT modified.');
  console.log('This is a source-build check, NOT yet a production packaging step.');
}

main();
