"""Extract all Chromium .pak files using empirical table detection."""
import os
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paklib import extract  # noqa: E402  (needs sys.path bootstrap above)
ROOT = 'C:/Users/wagde/MegaProjects/KnockDesk'
SKIP_DIRS = ('node_modules', 'venv', '__pycache__', '.git', '.next')
paks = []
for root, dirs, files in os.walk(ROOT):
    dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
    for f in files:
        if f.lower().endswith('.pak'):
            paks.append(os.path.join(root, f))
print('pak targets: %d' % len(paks))
ok, fail = 0, []
for i, p in enumerate(paks):
    try:
        with open(p, 'rb') as fh:
            data = fh.read()
        start, entries = extract(data)
        d = p + '.extracted'
        os.makedirs(d, exist_ok=True)
        offs = sorted(set(o for _, o in entries))
        bounds = {o: (offs[j + 1] if j + 1 < len(offs) else len(data)) for j, o in enumerate(offs)}
        with open(os.path.join(d, 'manifest.txt'), 'w') as mf:
            mf.write('source: %s\ntable_at: %d\nentries: %d\n\nid\toffset\tsize\tfile\n' % (
                os.path.basename(p), start, len(entries)))
            for rid, roff in sorted(entries):
                blob = data[roff:bounds[roff]]
                fn = '%d.bin' % rid
                with open(os.path.join(d, fn), 'wb') as out:
                    out.write(blob)
                mf.write('%d\t%d\t%d\t%s\n' % (rid, roff, len(blob), fn))
        ok += 1
        if (i + 1) % 100 == 0:
            print('... %d/%d done' % (i + 1, len(paks)))
    except Exception as e:
        fail.append((os.path.relpath(p, ROOT), str(e)[:100]))
print('pak OK: %d, FAILED: %d' % (ok, len(fail)))
for rel, err in fail:
    print('FAILED-FILE:', rel, '|', err)
