"""Empirical DataPack extractor: locate entry table by pattern, slice blobs."""
import struct

def find_table(data):
    n = len(data)
    best = (0, 0)  # (runlen, start)
    for start in range(8, 80):
        prev = -1
        pos = start
        run = 0
        while pos + 6 <= n:
            rid, roff = struct.unpack('<HI', data[pos:pos + 6])
            if roff <= prev or roff < 256 or roff >= n:
                break
            if rid > 200000:
                break
            prev = roff
            run += 1
            pos += 6
        if run > best[0]:
            best = (run, start)
    return best

def extract(data):
    runlen, start = find_table(data)
    if runlen < 8:
        raise ValueError('no entry table found')
    entries = []
    pos = start
    while pos + 6 <= len(data):
        rid, roff = struct.unpack('<HI', data[pos:pos + 6])
        if roff >= len(data):
            break
        if entries and roff < entries[-1][1]:
            break
        entries.append((rid, roff))
        pos += 6
    return start, entries
