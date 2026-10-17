// Reader validation: extractZip (unpack.mjs) must round-trip a zip written by
// zip-with-mode.mjs, including symlink detection.
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipDirectory } from '../scripts/zip-with-mode.mjs';
import { extractZip } from '../scripts/unpack.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const tree = join(root, 'tree');
const zipOut = join(root, 'out.zip');
const outDir = join(root, 'unzipped');
rmSync(outDir, { recursive: true, force: true });

const symlinks = new Map([['sub/python-link', '../../python/bin/python3.11']]);
zipDirectory(tree, zipOut, { symlinks });
const got = extractZip(zipOut, outDir);

const expected = new Map([...symlinks]);
for (const [name, target] of got) {
    if (expected.get(name) !== target) {
        throw new Error(`symlink mismatch for ${name}: ${JSON.stringify(target)}`);
    }
}
if (got.size !== expected.size) {
    throw new Error(`symlink count ${got.size} != ${expected.size}`);
}
const deep = readFileSync(join(outDir, 'sub/deep.txt'));
if (deep.length !== 100000) throw new Error('deep.txt size wrong: ' + deep.length);
if (!existsSync(join(outDir, 'macho.bin'))) throw new Error('macho.bin missing');
if (readFileSync(join(outDir, 'plain.txt')).toString() !== 'hello\n') throw new Error('plain.txt content wrong');
if (existsSync(join(outDir, 'sub/python-link'))) throw new Error('symlink must not be materialised on disk');
console.log('READER_OK');
