#!/usr/bin/env python3
"""
Strip the Authenticode signature from every signed PE in a directory tree.

An MSIX package is signed as a whole. The Appx signer refuses a package
that contains an executable or a DLL carrying its own signature, because
the two would conflict: the file's signature is computed over the file
as it is, and the package's signature is computed over the file inside
the package, so the inner one is already stale the moment the package
is written.

The embedded Python runtime ships two modules that carry a signature,
the Tcl and Tk libraries, and they are what stopped the package from
signing. Stripping the signature changes nothing about the code; the
package's own signature covers the file from then on.

This finds every PE with a certificate table and clears it.
"""
import os
import struct
import sys


def find_cert_table(data):
    """The certificate table's file offset and size, or None."""
    if len(data) < 0x40 or data[:2] != b'MZ':
        return None
    pe = struct.unpack_from('<I', data, 0x3c)[0]
    if pe + 24 > len(data) or data[pe:pe + 4] != b'PE\0\0':
        return None
    num_dirs = struct.unpack_from('<I', data, pe + 4 + 16)[0]
    if num_dirs <= 4:
        return None
    opt = pe + 24
    magic = struct.unpack_from('<H', data, opt)[0]
    if magic not in (0x10b, 0x20b):
        return None
    dd = opt + (112 if magic == 0x20b else 96)
    if dd + 4 * 8 + 8 > len(data):
        return None
    rva, size = struct.unpack_from('<II', data, dd + 4 * 8)
    if not size:
        return None
    return dd + 4 * 8, rva, size


def pe_checksum(data, pe):
    """The PE checksum, with the checksum field treated as zero."""
    opt = pe + 24
    total = 0
    limit = len(data) & ~1
    for i in range(0, limit, 2):
        if opt + 64 <= i < opt + 68:
            continue
        total += struct.unpack_from('<H', data, i)[0]
        total = (total & 0xffff) + (total >> 16)
    total = (total & 0xffff) + (total >> 16)
    return (total + len(data)) & 0xffffffff


def strip(path):
    """Remove a PE's Authenticode signature. Returns the bytes removed."""
    with open(path, 'rb') as f:
        data = bytearray(f.read())

    found = find_cert_table(data)
    if not found:
        return 0
    entry, rva, size = found

    # Clear the certificate table entry so nothing points at the
    # signature any more.
    struct.pack_into('<II', data, entry, 0, 0)

    # The signature is a file offset rather than an rva, and it sits at
    # the end of the file, so the file can be cut back to just before it.
    if 0 < rva < len(data):
        del data[rva:]

    # The checksum covers the file, so it has to be recomputed.
    pe = struct.unpack_from('<I', data, 0x3c)[0]
    opt = pe + 24
    struct.pack_into('<I', data, opt + 64, 0)
    struct.pack_into('<I', data, opt + 64, pe_checksum(data, pe))

    with open(path, 'wb') as f:
        f.write(data)
    return size


def main(root):
    changed = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ('node_modules', '__pycache__')]
        for name in filenames:
            if not name.lower().endswith(('.dll', '.exe', '.sys', '.pyd', '.msi', '.ocx', '.cpl')):
                continue
            p = os.path.join(dirpath, name)
            try:
                removed = strip(p)
            except (OSError, struct.error):
                continue
            if removed:
                rel = os.path.relpath(p, root)
                changed.append((rel, removed))
    return changed


if __name__ == '__main__':
    root = sys.argv[1]
    for rel, removed in main(root):
        print(f'   stripped the signature from {rel} ({removed:,} B)')
    if not main.__doc__:
        pass
