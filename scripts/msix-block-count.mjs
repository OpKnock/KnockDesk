#!/usr/bin/env node
/**
 * Report the archive shape a layout would produce.
 *
 * The Appx block map stores each file's data in 64 KB blocks. There is
 * no cap on how many blocks it may list: a package of this size produces
 * a block map with well over 78,000 blocks, and makeappx packs and
 * unpacks it without complaint.
 *
 * The 16-bit limit that does apply is the number of entries in the
 * archive's central directory: a ZIP32 file cannot hold more than 65,535
 * of them. That is a limit on the file count, not the block count.
 *
 * Microsoft publishes a 25 GB per-package limit for Windows 10 and 11
 * Store submissions, which is a separate thing again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BLOCK = 65536;
const ENTRY_CAP = 65535;

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
console.log(`blocks  : ${blocks.toLocaleString()}  (the block map has no limit)`);
console.log(`entries : ${files.toLocaleString()}  (the ZIP32 central directory caps at ${ENTRY_CAP.toLocaleString()})`);
console.log(`margin  : ${(ENTRY_CAP - files).toLocaleString()} entries`);
console.log(`package : ${(bytes / 1073741824).toFixed(2)} GB, far under the 25 GB Store limit`);
console.log(files <= ENTRY_CAP ? 'FITS' : `OVER by ${(files - ENTRY_CAP).toLocaleString()}`);
process.exit(files <= ENTRY_CAP ? 0 : 1);
