"""Count files in an .asar via its header JSON (no node/npx needed).
Layout: [sizepickle: payload_size=4][header_size:u32][headerpickle:
payload_size:u32][strlen:u32][json (+2 pad)] — JSON starts at offset 16.
"""
import struct
import json

def count_files(path):
    with open(path, 'rb') as f:
        head = f.read(20)
    strlen = struct.unpack('<I', head[12:16])[0]
    with open(path, 'rb') as f:
        f.seek(16)
        js = f.read(strlen).decode('utf-8')
    tree = json.loads(js)['files']
    n = 0
    stack = [tree]
    while stack:
        node = stack.pop()
        for name, entry in node.items():
            if 'files' in entry:
                stack.append(entry['files'])
            else:
                n += 1
    return n

if __name__ == '__main__':
    import sys
    print(count_files(sys.argv[1]))
