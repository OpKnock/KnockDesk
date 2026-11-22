"""Equalize splash logos at medium: container 224->256px, mark 140->200px."""
import sys
p = sys.argv[1]
d = open(p, encoding='utf-8').read()
a = 'relative w-56 h-56 mb-9 flex items-center justify-center'
b = 'relative w-64 h-64 mb-9 flex items-center justify-center'
c = 'w-[140px] h-[140px] object-contain relative z-10'
e = 'w-[200px] h-[200px] object-contain relative z-10'
assert d.count(a) == 1, 'container anchor: %d' % d.count(a)
assert d.count(c) == 1, 'logo anchor: %d' % d.count(c)
d = d.replace(a, b).replace(c, e)
open(p, 'w', encoding='utf-8').write(d)
print('splash equalized OK')
