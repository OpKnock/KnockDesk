/**
 * PK-ZIP writer that stores real Unix file modes and symlinks.
 *
 * macOS refuses to run an app whose Mach-O binaries lack the execute bit.
 * Ordinary Windows zip tooling drops Unix permissions entirely, so an app
 * extracted from it fails with "permission denied". This writer embeds
 * mode bits (version-made-by = Unix) in every entry: 0755 for anything that
 * looks like an executable (Mach-O magic or a #! shebang), 0755 for
 * directories, 0644 otherwise, plus 0777 file symlinks with their target
 * string as payload.
 *
 * Writes incrementally to the output file, so peak memory stays small even
 * for multi-hundred-megabyte entries (the 515MB app.asar is stored raw).
 */
import { readdirSync, readFileSync, mkdirSync, openSync, writeSync, closeSync, fstatSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';

const UNIX = 3;          // version-made-by host: Unix
const MIN_VERSION = 20;  // spec version needed to extract
const UTF8_FLAG = 0x0800;

const STORE_EXTENSIONS = new Set(['.asar', '.zip', '.tgz']);

function isExecutable(buf) {
    if (!buf || buf.length < 4) return false;
    const u32 = buf.readUInt32LE(0);
    // Mach-O 64 (LE), Fat multi-arch (LE/BE), Mach-O 32 (BE)
    if (u32 === 0xFEEDFACF || u32 === 0xBEBAFECA || u32 === 0xFEEDFACE) return true;
    // script with shebang
    return buf.length > 2 && buf[0] === 0x23 && buf[1] === 0x21;
}

function modeForFile(buf) {
    return isExecutable(buf) ? 0o100755 : 0o100644;
}

class ZipWriter {
    constructor(fd) {
        this.fd = fd;
        this.offset = 0;
        this.central = [];
    }

    push(buf) {
        writeSync(this.fd, buf);
        this.offset += buf.length;
    }

    add({ name, data = null, mode = null, isDir = false, symlinkTarget = null }) {
        const nameBuf = Buffer.from(name, 'utf8');
        const store = isDir || symlinkTarget !== null || STORE_EXTENSIONS.has(sepOrSlashExt(name));

        let payload;
        let externalAttr;
        if (symlinkTarget !== null) {
            payload = Buffer.from(symlinkTarget, 'utf8');
            externalAttr = (0o120777 << 16) >>> 0;
        } else if (isDir) {
            payload = Buffer.alloc(0);
            externalAttr = (0o040755 << 16) | 0x10; // unix dir + DOS dir bit
        } else {
            payload = data;
            externalAttr = ((mode ?? 0o100644) << 16) >>> 0;
        }

        const crc = crc32(payload) >>> 0;
        const compressed = store ? payload : deflateRawSync(payload, { level: 6 });
        // fall back to storing when deflate doesn't help — and push the bytes
        // that match the declared method
        const usedMethod = (store || compressed.length >= payload.length) ? 0 : 8;
        const body = usedMethod === 8 ? compressed : payload;

        const flags = UTF8_FLAG;
        const localOffset = this.offset;

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(MIN_VERSION, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(usedMethod, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(payload.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        this.push(local);
        this.push(nameBuf);
        if (body.length) this.push(body);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE((UNIX << 8) | MIN_VERSION, 4); // version made by (unix)
        central.writeUInt16LE(MIN_VERSION, 6);
        central.writeUInt16LE(flags, 8);
        central.writeUInt16LE(usedMethod, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(payload.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(externalAttr, 38);
        central.writeUInt32LE(localOffset, 42);
        this.central.push(Buffer.concat([central, nameBuf]));
    }
}

function sepOrSlashExt(name) {
    const i = name.lastIndexOf('.');
    return i === -1 ? '' : name.slice(i).toLowerCase();
}

/**
 * Zip a directory tree to outPath. Files: mode sniffed from content; entries
 * under store-extensions stored raw. Symlinks: Map<relativePath, target>.
 */
export function zipDirectory(root, outPath, { symlinks = new Map(), onEntry = null } = {}) {
    mkdirSync(dirname(outPath), { recursive: true });
    const fd = openSync(outPath, 'w');
    try {
        const writer = new ZipWriter(fd);

        const walk = (dir) => {
            for (const item of readdirSync(dir, { withFileTypes: true })) {
                const abs = join(dir, item.name);
                const rel = relative(root, abs).split(sep).join('/');
                if (symlinks.has(rel)) continue; // added below as symlink

                if (item.isDirectory()) {
                    writer.add({ name: rel + '/', isDir: true });
                    walk(abs);
                } else {
                    const data = readFileSync(abs);
                    writer.add({ name: rel, data, mode: modeForFile(data) });
                }
                if (onEntry) onEntry(rel);
            }
        };
        walk(root);

        for (const rel of symlinks.keys()) {
            writer.add({ name: rel, symlinkTarget: symlinks.get(rel) });
        }

        const cdOffset = writer.offset;
        for (const rec of writer.central) writer.push(rec);
        const cdSize = writer.offset - cdOffset;

        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(0, 4);
        eocd.writeUInt16LE(0, 6);
        eocd.writeUInt16LE(writer.central.length, 8);
        eocd.writeUInt16LE(writer.central.length, 10);
        eocd.writeUInt32LE(cdSize, 12);
        eocd.writeUInt32LE(cdOffset, 16);
        eocd.writeUInt16LE(0, 20);
        writer.push(eocd);

        const bytes = fstatSync(fd).size;
        return { entries: writer.central.length, bytes };
    } finally {
        closeSync(fd);
    }
}

export default zipDirectory;
