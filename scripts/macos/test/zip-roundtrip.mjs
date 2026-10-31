// Round-trip: write a tree with zip-with-mode, verify with Python zipfile.
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipDirectory } from '../zip-with-mode.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const tree = join(root, 'tree');
const zipOut = join(root, 'out.zip');
rmSync(tree, { recursive: true, force: true });
rmSync(zipOut, { force: true });

mkdirSync(join(tree, 'sub/emptydir'), { recursive: true });
writeFileSync(join(tree, 'plain.txt'), 'hello\n');
writeFileSync(join(tree, 'macho.bin'), Buffer.concat([Buffer.from([0xCF, 0xFA, 0xED, 0xFE]), Buffer.alloc(100)]));
writeFileSync(join(tree, 'script.sh'), '#!/bin/sh\necho hi\n');
writeFileSync(join(tree, 'sub/deep.txt'), 'x'.repeat(100000));
const symlinks = new Map([['sub/python-link', '../../python/bin/python3.11']]);

const { entries, bytes } = zipDirectory(tree, zipOut, { symlinks });
console.log('wrote', entries, 'entries,', bytes, 'bytes');

const py = process.env.KNOCKDESK_PY || 'python';
const { execFileSync } = await import('node:child_process');
const check = execFileSync(py, ['-c', `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
assert bad is None, 'CRC bad: ' + str(bad)
for i in z.infolist():
    mode = (i.external_attr >> 16) & 0o7777
    print(f"{i.filename!r} mode={oct(mode)} size={i.file_size}")
data = z.read('plain.txt')
assert data == b'hello\\n', data
assert z.read('sub/python-link') == b'../../python/bin/python3.11'
print('ROUNDTRIP_OK')
`, zipOut], { stdio: 'pipe' });
console.log(check.toString());
