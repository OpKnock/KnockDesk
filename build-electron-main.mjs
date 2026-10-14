#!/usr/bin/env node
/**
 * KnockDesk Electron Main Process Build Script
 * 
 * Compiles TypeScript sources and bundles with bytenode to produce main.jsc
 * for production distribution.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ELECTRON_DIR = path.resolve('resources/hermes-runtime/src/electron');
const OUTPUT_DIR = path.resolve('resources/app.asar.unpacked/electron');

function run(cmd: string, cwd: string = ELECTRON_DIR): void {
  console.log(`$ ${cmd}`);
  try {
    execSync(cmd, { cwd, stdio: 'inherit', encoding: 'utf-8' });
  } catch (error) {
    console.error(`Command failed: ${cmd}`);
    process.exit(1);
  }
}

function main(): void {
  console.log('🔨 Building KnockDesk Electron Main Process...\n');

  // 1. Install dependencies
  console.log('📦 Installing dependencies...');
  run('npm ci --prefer-offline --no-audit');

  // 2. Type check
  console.log('\n🔍 Type checking...');
  run('npx tsc --noEmit');

  // 3. Compile with bytenode
  console.log('\n📦 Compiling with bytenode...');
  run('npx bytenode --compile main.ts --output main.jsc');

  // 4. Verify the compiled output
  console.log('\n✅ Verifying compiled output...');
  run('node -e "require(\'bytenode\'); require(\'./main.jsc\'); console.log(\'main.jsc loads successfully\')"');

  // 5. Copy to app.asar.unpacked for testing
  console.log('\n📋 Copying to app.asar.unpacked...');
  const outputFiles = ['main.jsc', 'preload.js', 'agenttown-preload.js', 'hermes-preload.js'];
  for (const file of outputFiles) {
    const src = path.join(ELECTRON_DIR, file);
    const dest = path.join(OUTPUT_DIR, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`  Copied ${file}`);
    }
  }

  // Copy main directory structure
  const mainDirSrc = path.join(ELECTRON_DIR, 'main');
  const mainDirDest = path.join(OUTPUT_DIR, 'main');
  if (fs.existsSync(mainDirSrc)) {
    copyDir(mainDirSrc, mainDirDest);
    console.log('  Copied main/ directory');
  }

  // Copy services
  const servicesSrc = path.join(ELECTRON_DIR, 'services');
  const servicesDest = path.join(OUTPUT_DIR, 'services');
  if (fs.existsSync(servicesSrc)) {
    copyDir(servicesSrc, servicesDest);
    console.log('  Copied services/ directory');
  }

  // Copy pwa
  const pwaSrc = path.join(ELECTRON_DIR, 'pwa');
  const pwaDest = path.join(OUTPUT_DIR, 'pwa');
  if (fs.existsSync(pwaSrc)) {
    copyDir(pwaSrc, pwaDest);
    console.log('  Copied pwa/ directory');
  }

  // Copy preload scripts
  const preloadFiles = ['preload.js', 'agenttown-preload.js', 'hermes-preload.js'];
  for (const file of preloadFiles) {
    const src = path.join(ELECTRON_DIR, file);
    const dest = path.join(OUTPUT_DIR, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  }

  console.log('\n✅ Build complete!');
  console.log(`📁 Output: ${OUTPUT_DIR}`);
  console.log('\n📦 To repack app.asar, run:');
  console.log('   npx asar pack resources/app.asar.unpacked resources/app.asar');
}

function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

main();