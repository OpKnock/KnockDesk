"""Unpack every zip/whl + Chromium .pak in the repo (read sources, write siblings).
Usage: python unpack-all.py  (cwd = repo root)
Outputs: <file>.extracted/ next to each archive + UNPACK-REPORT.txt lines on stdout.
"""
import os
import sys
import io
import zipfile
import struct
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
ROOT = 'C:/Users/wagde/MegaProjects/KnockDesk'
SKIP_DIRS = ('node_modules', 'venv', '__pycache__', '.git', '.next')
ok, fail = 0, []

def out_dir(path):
    d = path + '.extracted'
    os.makedirs(d, exist_ok=True)
    return d

def unpack_zip(path):
    d = out_dir(path)
    with zipfile.ZipFile(path) as z:
        bad = z.testzip()
        if bad:
            return 'CORRUPT entry: %s' % bad
        z.extractall(d)
        return 'zip OK (%d entries)' % len(z.namelist())

def parse_pak(data):
    """Return (entries, encoding) or raise. Supports DataPack v4/v5 layouts."""
    if len(data) < 8:
        raise ValueError('too small')
    version = struct.unpack('<I', data[0:4])[0]
    if version not in (4, 5):
        raise ValueError('unknown version %d' % version)
    encoding = data[4]
    rcount = struct.unpack('<H', data[5:7])[0]
    entries = []
    if version == 4:
        # v4: [ver:4][enc:1][count:2][textenc:1] then (id:2, offset:4)*count
        off = 8
        for _ in range(rcount):
            rid, roff = struct.unpack('<HI', data[off:off + 6])
            entries.append((rid, roff))
            off += 6
    else:
        # v5: [ver:4][enc:1][count:2][aliascount:2] then entries then aliases
        acount = struct.unpack('<H', data[7:9])[0]
        off = 9
        for _ in range(rcount):
            rid, roff = struct.unpack('<HI', data[off:off + 6])
            entries.append((rid, roff))
            off += 6
        # alias table (id:2, index:2) — resolve aliases to entry offsets
        aliases = {}
        for _ in range(acount):
            aid, aidx = struct.unpack('<HH', data[off:off + 4])
            aliases[aid] = aidx
            off += 4
        for aid, aidx in aliases.items():
            if 0 <= aidx < len(entries):
                entries.append((aid, entries[aidx][1]))
    # validate: offsets ascending, in range
    offs = sorted(set(o for _, o in entries))
    if not offs or offs[0] < 8 or offs[-1] > len(data):
        raise ValueError('bad offsets')
    if any(b < a for a, b in zip(offs, offs[1:])):
        raise ValueError('non-monotonic')
    return entries, encoding

def unpack_pak(path):
    with open(path, 'rb') as f:
        data = f.read()
    entries, encoding = parse_pak(data)
    d = out_dir(path)
    offs = sorted(set(o for _, o in entries))
    bounds = {o: (offs[i + 1] if i + 1 < len(offs) else len(data)) for i, o in enumerate(offs)}
    with open(os.path.join(d, 'manifest.txt'), 'w') as mf:
        mf.write('source: %s\nversion-bytes: %s\nencoding: %d\nentries: %d\n\n' % (
            os.path.basename(path), data[:8].hex(), encoding, len(entries)))
        mf.write('id\toffset\tsize\tfile\n')
        for rid, roff in sorted(entries):
            end = bounds[roff]
            blob = data[roff:end]
            fn = '%d.bin' % rid
            with open(os.path.join(d, fn), 'wb') as out:
                out.write(blob)
            mf.write('%d\t%d\t%d\t%s\n' % (rid, roff, len(blob), fn))
    return 'pak OK (%d entries)' % len(entries)

# collect targets
zips, paks = [], []
for root, dirs, files in os.walk(ROOT):
    dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
    for f in files:
        low = f.lower()
        full = os.path.join(root, f)
        if low.endswith('.zip') or low.endswith('.whl'):
            zips.append(full)
        elif low.endswith('.pak'):
            paks.append(full)

print('targets: %d zip/whl, %d pak' % (len(zips), len(paks)))
for p in zips:
    try:
        print('OK  ', os.path.relpath(p, ROOT), '->', unpack_zip(p))
        ok += 1
    except Exception as e:
        print('FAIL', os.path.relpath(p, ROOT), str(e)[:120])
        fail.append(p)
for i, p in enumerate(paks):
    try:
        msg = unpack_pak(p)
        ok += 1
        if i < 5 or (i + 1) % 100 == 0:
            print('OK  ', os.path.relpath(p, ROOT), '->', msg)
    except Exception as e:
        print('FAIL', os.path.relpath(p, ROOT), str(e)[:120])
        fail.append(p)
print('unpacked OK: %d, FAILED: %d' % (ok, len(fail)))
for p in fail:
    print('FAILED-FILE:', os.path.relpath(p, ROOT))
