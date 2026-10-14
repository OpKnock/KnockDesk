"""Re-crop to the SOLID core (alpha>128) so small sizes stay big. Regenerate all assets + ICO."""
from PIL import Image
import os

ROOT = 'C:/Users/wagde/MegaProjects/KnockDesk'
MASTER = ROOT + '/resources/public/knockdesk-logo-1024.png'

im = Image.open(MASTER).convert('RGBA')
alpha = im.split()[3]
# solid core only (ignore faint glow fringe)
solid = alpha.point(lambda v: 255 if v > 128 else 0)
bbox = solid.getbbox()
print('solid bbox:', bbox)
left, top, r, b = bbox
w, h = r - left, b - top
side = max(w, h)
pad = int(side * 0.04)
cx, cy = (left + r) // 2, (top + b) // 2
half = side // 2 + pad
box = (max(0, cx - half), max(0, cy - half), min(im.size[0], cx + half), min(im.size[1], cy + half))
cropped = im.crop(box)
print('cropped:', cropped.size)

targets = [
    (ROOT + '/resources/public/logo.png', 1024),
    (ROOT + '/resources/hermes-runtime/src/electron/pwa/logo.png', 512),
    (ROOT + '/resources/hermes-runtime/src/electron/pwa/icon-512.png', 512),
    (ROOT + '/resources/hermes-runtime/src/electron/pwa/icon-192.png', 192),
]
for path, size in targets:
    cropped.resize((size, size), Image.LANCZOS).save(path)
    print('wrote %s %dx%d' % (os.path.relpath(path, ROOT), size, size))

# ICO with all layers from the solid-core crop
cropped.resize((256, 256), Image.LANCZOS).save(
    ROOT + '/resources/public/knockdesk-icon.ico',
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('ico rebuilt')

# verify the 32px layer with the same bright-pixel metric
chk = cropped.resize((32, 32), Image.LANCZOS).convert('RGB')
px = chk.load()
lit = [(x, y) for y in range(32) for x in range(32) if sum(px[x, y]) > 120]
xs = [p[0] for p in lit]
ys = [p[1] for p in lit]
print('32px check covers: x %.0f%% y %.0f%%' % (100 * (max(xs) - min(xs) + 1) / 32, 100 * (max(ys) - min(ys) + 1) / 32))
print('DONE')
