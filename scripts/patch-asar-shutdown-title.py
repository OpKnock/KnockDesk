"""Replace the 5 NUL bytes in the shutdown-overlay title with spaces (equal length)."""
import sys
p = sys.argv[1]
data = bytearray(open(p, 'rb').read())
needle = b'KnockDesk...' + b'\x00' * 5 + b"';"
i = data.find(needle)
assert i > 0, 'pattern not found'
print('pattern at offset:', i)
data[i + 12:i + 17] = b'     '
open(p, 'wb').write(data)
# verify
d2 = open(p, 'rb').read()
j = d2.find(b'KnockDesk...     ')
assert j == i, 'verify failed'
print('patched + verified at offset:', j)
