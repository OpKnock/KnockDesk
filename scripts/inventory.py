"""Inventory — lists every file in this app folder with sizes.

Usage: python scripts/inventory.py
Writes: staging/INVENTORY.md
"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'staging' / 'INVENTORY.md'

rows = []
total = 0
for p in sorted(ROOT.rglob('*')):
    if not p.is_file():
        continue
    rel = p.relative_to(ROOT).as_posix()
    if rel.startswith('.git/'):
        continue
    try:
        sz = p.stat().st_size
    except OSError:
        continue
    total += sz
    rows.append((rel, sz))

OUT.parent.mkdir(parents=True, exist_ok=True)
with OUT.open('w', encoding='utf-8') as f:
    f.write('# Inventory — KnockDesk AI (full app, exe included)\n\n')
    f.write(f'Total files: {len(rows)} — {total/1e9:.2f} GB\n\n')
    f.write('| File | Bytes |\n|---|---|\n')
    for rel, sz in rows:
        f.write(f'| `{rel}` | {sz} |\n')
print(f'wrote {OUT} ({len(rows)} files, {total/1e9:.2f} GB)')
