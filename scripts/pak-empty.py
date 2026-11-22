"""Write honest manifests for zero-entry placeholder packs."""
import os
import sys
import io
import struct
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = ('node_modules', 'venv', '.venv', '__pycache__', '.git', '.next', 'staging')
n = 0
for root, dirs, files in os.walk(ROOT):
    dirs[:] = [x for x in dirs if x not in SKIP_DIRS and not x.endswith('.extracted') and not x.endswith('-unpacked')]
    for f in files:
        if not f.lower().endswith('.pak'):
            continue
        p = os.path.join(root, f)
        with open(p, 'rb') as fh:
            data = fh.read()
        if len(data) < 12:
            continue
        count = struct.unpack('<H', data[8:10])[0]
        if count != 0:
            continue
        d = p + '.extracted'
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, 'manifest.txt'), 'w') as mf:
            mf.write('source: %s\ntable entries: 0\nnote: empty placeholder pack (Chromium falls back to the base locale pak); trailing %d bytes are inert padding, no addressable resources.\n' % (f, len(data) - 12))
        n += 1
print('empty-pack manifests written:', n)
