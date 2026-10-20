#!/usr/bin/env node
/**
 * Report the block count a layout would produce.
 *
 * The Appx block map holds one entry per 64 KB of file data, and the
 * format caps it at 65,535. This counts the blocks a layout needs
 * without packing it, so the build can be checked before the slow step.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BLOCK = 65536;
const CAP = 65535;

const LAYOUT = process.argv[2] ||
  path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'staging', 'msix-layout');

let blocks = 0;
let bytes = 0;
let files = 0;

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p);
    } else {
      const s = fs.statSync(p).size;
      blocks += Math.max(1, Math.ceil(s / BLOCK));
      bytes += s;
      files++;
    }
  }
}

walk(LAYOUT);

console.log(`files   : ${files.toLocaleString()}`);
console.log(`bytes   : ${bytes.toLocaleString()} (${(bytes / 1073741824).toFixed(2)} GB)`);
console.log(`blocks  : ${blocks.toLocaleString()}  (the Appx cap is ${CAP.toLocaleString()})`);
console.log(`margin  : ${(CAP - blocks).toLocaleString()} blocks`);
console.log(blocks <= CAP ? 'FITS' : `OVER by ${(blocks - CAP).toLocaleString()}`);
process.exit(blocks <= CAP ? 0 : 1);
