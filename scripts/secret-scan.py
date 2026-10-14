"""Scan shipped source for real-looking API key material (not placeholders)."""
import io
import os
import re
import sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
ROOT = 'C:/Users/wagde/MegaProjects/KnockDesk'
SKIP_DIRS = ('node_modules', 'venv', '__pycache__', '.git', '.next', 'site-packages')
SKIP_FILES = ('package-lock.json', '.env.example')
PATS = {
    'anthropic': re.compile(r'sk-ant-[A-Za-z0-9\-_]{20,}'),
    'openrouter': re.compile(r'sk-or-v1-[A-Za-z0-9]{20,}'),
    'google': re.compile(r'AIza[0-9A-Za-z\-_]{25,}'),
    'github': re.compile(r'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}'),
    'slack': re.compile(r'xox[bap]-[A-Za-z0-9\-]{10,}'),
    'openai': re.compile(r'sk-[A-Za-z0-9]{24,}(?<![.=/-])'),
}
PLACEHOLDER = re.compile(r'YOUR_|EXAMPLE|XXX+|PLACEHOLDER|<.*>|your-.*-here|test|demo|fake', re.I)
roots = sys.argv[1:] or [ROOT]
hits = 0
for base in roots:
    base = base if os.path.isabs(base) else os.path.join(ROOT, base)
    if os.path.isfile(base):
        targets = [base]
    else:
        targets = []
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for f in files:
                targets.append(os.path.join(root, f))
    for p in targets:
        if os.path.basename(p) in SKIP_FILES:
            continue
        try:
            if os.path.getsize(p) > 30 * 1024 * 1024:
                continue
            content = open(p, 'rb').read().decode('utf-8', errors='ignore')
        except Exception:
            continue
        for i, line in enumerate(content.split('\n'), 1):
            for kind, pat in PATS.items():
                m = pat.search(line)
                if m and not PLACEHOLDER.search(line):
                    safe = line.strip().encode('ascii', errors='replace').decode('ascii')
                    print('%s:%d [%s] %s' % (os.path.relpath(p, ROOT), i, kind, safe[:160]))
                    hits += 1
                    if hits >= 40:
                        print('... capped at 40')
                        sys.exit(0)
print('total candidate hits:', hits)
