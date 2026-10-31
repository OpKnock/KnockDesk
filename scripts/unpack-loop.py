"""Loop until every packed file is unpacked + verified. Exit 0 = zero gaps."""
import os
import sys
import io
import zipfile
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = ('venv', '.venv', '__pycache__', '.git', '.next', 'staging')
ARCH_EXTS = ('.asar', '.zip', '.whl', '.pak')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def walk_files():
    out = []
    for root, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.endswith('.extracted') and not d.endswith('-unpacked')]
        for f in files:
            out.append(os.path.join(root, f))
    return out

def is_under_node_modules(p):
    return 'node_modules' in p.replace('\\', '/').split('/')

gaps = []
# ---- 1. discover all archive targets (incl. nested, excl. node_modules bodies) ----
targets = []
thirdparty_hits = []
for p in walk_files():
    low = p.lower()
    if low.endswith(ARCH_EXTS) and not low.endswith('.extracted'):
        # skip anything already inside an .extracted dir's node_modules? no—still list
        if is_under_node_modules(p):
            thirdparty_hits.append(os.path.relpath(p, ROOT))
        else:
            targets.append(p)
print('archive targets (own code): %d' % len(targets))
print('archive files inside node_modules (reported only): %d' % len(thirdparty_hits))
for t in thirdparty_hits[:20]:
    print('  thirdparty: ' + t)
if len(thirdparty_hits) > 20:
    print('  ... +%d more' % (len(thirdparty_hits) - 20))

# ---- 2. verify each has a valid .extracted/ ----
for p in targets:
    rel = os.path.relpath(p, ROOT)
    d = p + '.extracted'
    low = p.lower()
    if not os.path.isdir(d):
        gaps.append('missing-extracted: ' + rel)
        continue
    try:
        if low.endswith('.asar'):
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            import asarcount
            want = asarcount.count_files(p)
            got = sum(len(fs) for _, _, fs in os.walk(d))
            if want != got:
                gaps.append('asar-count-mismatch %s (header=%d disk=%d)' % (rel, want, got))
        elif low.endswith('.zip') or low.endswith('.whl'):
            with zipfile.ZipFile(p) as z:
                names = [n for n in z.namelist() if not n.endswith('/')]
            missing = [n for n in names if not os.path.exists(os.path.join(d, n.replace('/', os.sep)))]
            if missing:
                gaps.append('zip-missing-entries %s (%d missing, e.g. %s)' % (rel, len(missing), missing[0]))
        elif low.endswith('.pak'):
            mf = os.path.join(d, 'manifest.txt')
            if not os.path.isfile(mf):
                gaps.append('pak-no-manifest: ' + rel)
                continue
            with open(p, 'rb') as fh:
                data = fh.read()
            import paklib as pak2
            try:
                _, entries = pak2.extract(data)
                # count manifest data lines
                lines = open(mf).read().splitlines()
                data_lines = [ln for ln in lines if ln and not ln.startswith('source') and not ln.startswith('version') and not ln.startswith('encoding') and not ln.startswith('entries') and not ln.startswith('table') and not ln.startswith('note') and not ln.startswith('id\t')]
                if len(data_lines) != len(entries):
                    gaps.append('pak-manifest-mismatch %s (parsed=%d manifest=%d)' % (rel, len(entries), len(data_lines)))
            except Exception:
                # empty placeholder pack: manifest must say 0 entries
                txt = open(mf).read()
                if 'entries: 0' not in txt and '0 entries' not in txt:
                    gaps.append('pak-empty-unexplained: ' + rel)
    except Exception as e:
        gaps.append('verify-error %s: %s' % (rel, str(e)[:100]))

# ---- 3. no NEW unhandled pack types appeared ----
mystery_exts = ('.gz', '.tgz', '.tar', '.7z', '.rar', '.cab', '.nupkg', '.vsix', '.msi', '.jar', '.br', '.lzma', '.xz')
myst = [os.path.relpath(p, ROOT) for p in walk_files()
        if p.lower().endswith(mystery_exts) and not is_under_node_modules(p)]
if myst:
    gaps.append('new-pack-types: ' + '; '.join(myst[:10]))

# ---- 4. required project docs; private backups are checked only when configured ----
for rel in ['NOTICE.md', 'README.md', 'LICENSE']:
    if not os.path.isfile(os.path.join(ROOT, rel)):
        gaps.append('missing-required: ' + rel)

backup_dir = os.environ.get('KNOCKDESK_BACKUP_DIR')
if backup_dir:
    for name in ['README-pre-opensource-20261014.md',
                 'frontend-v1-20261014.zip',
                 'app-asar-v1-working-20261014.asar']:
        if not os.path.exists(os.path.join(backup_dir, name)):
            gaps.append('missing-configured-backup: ' + name)

# ---- 5. README stays public-safe; absolute-path scans are handled centrally ----
try:
    readme = open(os.path.join(ROOT, 'README.md'), encoding='utf-8').read()
    bad = [w for w in ['rebrand', 'KnockDesk-ops', 'surgery'] if w in readme]
    if bad:
        gaps.append('readme-clean: ' + '; '.join(bad))
except Exception as e:
    gaps.append('readme-unreadable: ' + str(e)[:80])

print()
if gaps:
    print('GAPS: %d' % len(gaps))
    for g in gaps:
        print('GAP: ' + g)
    sys.exit(1)
print('ALL GREEN — 0 gaps across %d archives' % len(targets))
