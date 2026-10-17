/**
 * Privilege-free extractors for the macOS build.
 *
 * The macOS payloads (Electron.app framework bundles, python-build-standalone)
 * contain Unix symlinks. Windows without elevation cannot create symlinks, and
 * .NET's Expand-Archive mangles them into text-file stubs. These extractors
 * parse the archive formats directly: regular files land on disk, symlinks are
 * returned as a Map<relativeName, target> and are materialised later by
 * zip-with-mode.mjs when the final zip is written (a ZIP stores symlinks as
 * entries whose payload is the target string — no OS support needed).
 *
 * Formats: PK-ZIP (deflate/store, no Zip64 — every entry is < 4GB) and
 * POSIX tar (typeflag '0'/'\0' regular, '5' dir, '2'/'L'? symlink = '2'),
 * wrapped in gzip.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { inflateRawSync, gunzipSync, crc32 } from 'node:zlib';

/** Security: reject entries that escape the destination. */
function safeJoin(dest, name) {
    if (name.includes('\0')) throw new Error('NUL in archive entry name');
    const norm = name.replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = norm.split('/').filter((p) => p !== '.' && p !== '..');
    const abs = join(dest, ...parts);
    if (relative(dest, abs).startsWith('..')) throw new Error('archive entry escapes destination: ' + name);
    return abs;
}

// ── PK-ZIP reader ────────────────────────────────────────────────────────────
function eocd(buf) {
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            return {
                count: buf.readUInt16LE(i + 10),
                cdSize: buf.readUInt32LE(i + 12),
                cdOffset: buf.readUInt32LE(i + 16),
            };
        }
    }
    throw new Error('EOCD not found');
}

function readCentralDirectory(zipBytes) {
    const { count, cdOffset } = eocd(zipBytes);
    let p = cdOffset;
    const entries = [];
    for (let i = 0; i < count; i++) {
        if (zipBytes.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory at ' + p);
        const flags = zipBytes.readUInt16LE(p + 8);
        const method = zipBytes.readUInt16LE(p + 10);
        const crc = zipBytes.readUInt32LE(p + 16);
        const compSize = zipBytes.readUInt32LE(p + 20);
        const uncompSize = zipBytes.readUInt32LE(p + 24);
        const nameLen = zipBytes.readUInt16LE(p + 28);
        const extraLen = zipBytes.readUInt16LE(p + 30);
        const commentLen = zipBytes.readUInt16LE(p + 32);
        const localOffset = zipBytes.readUInt32LE(p + 42);
        const name = zipBytes.toString('utf8', p + 46, p + 46 + nameLen);
        // Unix mode from version-made-by (high byte of the 16-bit "made by" OS)
        const madeBy = zipBytes.readUInt16LE(p + 4);
        const madeByOS = madeBy >> 8;
        const externalAttr = zipBytes.readUInt32LE(p + 38);
        const mode = madeByOS === 3 ? (externalAttr >> 16) & 0o777777 : 0;
        entries.push({ name, flags, method, crc, compSize, uncompSize, localOffset, mode });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

/** Is this entry a Unix symlink (mode high word type bits = 0o12xxx)? */
function isSymlinkEntry(e) {
    if ((e.mode & 0o170000) !== 0o120000) return false;
    return e.uncompSize < 4096; // symlink targets are short
}

/**
 * Extract a PK-ZIP. Returns Map<name-in-archive, symlinkTarget>.
 * Directory entries are materialised implicitly by file writes.
 */
export function extractZip(zipPath, destDir) {
    const zipBytes = readFileSync(zipPath);
    mkdirSync(destDir, { recursive: true });
    const symlinks = new Map();
    for (const e of readCentralDirectory(zipBytes)) {
        if (e.name.endsWith('/')) continue; // directories are implicit
        const abs = safeJoin(destDir, e.name);
        mkdirSync(dirname(abs), { recursive: true });

        // inflate from the local header (data desc offset)
        const p = e.localOffset;
        if (zipBytes.readUInt32LE(p) !== 0x04034b50) throw new Error('bad local header for ' + e.name);
        const nameLen = zipBytes.readUInt16LE(p + 26);
        const extraLen = zipBytes.readUInt16LE(p + 28);
        const dataStart = p + 30 + nameLen + extraLen;
        const raw = zipBytes.subarray(dataStart, dataStart + e.compSize);
        let data;
        if (e.method === 0) data = raw;
        else if (e.method === 8) data = inflateRawSync(raw);
        else throw new Error(`unsupported zip method ${e.method} for ${e.name}`);
        if (crc32(data) !== (e.crc >>> 0)) throw new Error('CRC mismatch: ' + e.name);

        if (isSymlinkEntry(e)) {
            symlinks.set(e.name.replace(/\\/g, '/'), data.toString('utf8'));
        } else {
            writeFileSync(abs, data);
        }
    }
    return symlinks;
}

// ── tar (gzip) reader ────────────────────────────────────────────────────────
export function extractTarGz(tarballPath, destDir) {
    const gz = readFileSync(tarballPath);
    const tarBytes = gunzipSync(gz);
    mkdirSync(destDir, { recursive: true });
    const symlinks = new Map();
    let paxPath = null; // PAX extended header path override for the next entry
    let p = 0;
    while (p + 512 <= tarBytes.length) {
        const header = tarBytes.subarray(p, p + 512);
        if (header.every((b) => b === 0)) break; // two zero blocks = end
        let name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
        const sizeStr = header.toString('utf8', 124, 136).replace(/[\0 ]/g, '');
        const size = sizeStr ? parseInt(sizeStr, 8) : 0;
        const typeflag = String.fromCharCode(header[156] === 0 ? 0x30 : header[156]);
        const linkname = header.toString('utf8', 157, 257).replace(/\0.*$/, '');
        const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
        let fullName = (prefix ? prefix + '/' : '') + name;
        const dataStart = p + 512;
        const dataEnd = dataStart + size;

        if (typeflag === 'L') { // GNU long name: next entry's name is in the data
            paxPath = tarBytes.toString('utf8', dataStart, dataEnd).replace(/\0.*$/, '');
            p = dataStart + Math.ceil(size / 512) * 512;
            continue;
        }
        if (typeflag === 'x' || typeflag === 'X') { // PAX extended header
            const records = tarBytes.toString('utf8', dataStart, dataEnd);
            for (const rec of records.split('\n')) {
                const m = rec.match(/^\d+ path=(.*)$/);
                if (m) paxPath = m[1];
            }
            p = dataStart + Math.ceil(size / 512) * 512;
            continue;
        }
        if (paxPath) { fullName = paxPath; paxPath = null; }

        if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
            const abs = safeJoin(destDir, fullName);
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, tarBytes.subarray(dataStart, dataEnd));
        } else if (typeflag === '2') { // symlink
            symlinks.set(fullName.replace(/\\/g, '/'), linkname);
        } // typeflag '5' (dir): implicit via file writes

        // next header: data padded to the 512-byte block boundary
        p = dataStart + Math.ceil(size / 512) * 512;
    }
    return symlinks;
}

/**
 * Rebase an extract-root-relative symlink map onto a different tree position:
 * strip `stripPrefix` from each name, prepend `newPrefix`.
 */
export function rebaseSymlinks(map, stripPrefix, newPrefix) {
    const out = new Map();
    for (const [name, target] of map) {
        const rel = stripPrefix && name.startsWith(stripPrefix)
            ? name.slice(stripPrefix.length).replace(/^\/+/, '')
            : name;
        out.set((newPrefix ? newPrefix + '/' : '') + rel, target);
    }
    return out;
}

export default { extractZip, extractTarGz, rebaseSymlinks };
