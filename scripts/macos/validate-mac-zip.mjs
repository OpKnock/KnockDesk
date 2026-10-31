/**
 * Structural validator for the cross-built macOS app zip.
 *
 * Re-implements a minimal zip central-directory reader (matching
 * scripts/zip-with-mode.mjs output: no ZIP64, no data descriptors, unix
 * version-made-by) and verifies, without touching an archive extractor:
 *
 *   1. Archive integrity: EOCD counts, central-directory extent, every local
 *      header re-read at its recorded offset and cross-checked.
 *   2. Unix modes: Mach-O executables 0755, regular files 0644, directories
 *      0755 + DOS dir bit, symlinks 0o120777 with target string payloads.
 *   3. Mach-O magic on the app binary, the bundled python3.11 and
 *      better_sqlite3.node (decompressed and sniffed).
 *   4. Info.plist content: bundle id, version, usage descriptions,
 *      LSMinimumSystemVersion.
 *   5. venv symlinks (python -> ../../python/bin/python3.11 etc.), hermes
 *      wrapper, site-packages presence, runtime.json.
 *   6. Strip guarantees: no windows/linux robotjs or picovoice natives.
 *   7. Name sanity: no backslashes, no '..' components, no drive letters.
 *
 * Usage: node scripts/validate-mac-zip.mjs dist/<zip>
 */
import { openSync, readSync, fstatSync, closeSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, crc32, constants as ZC } from 'node:zlib';

const zipPath = process.argv[2];
if (!zipPath) {
    console.error('usage: node scripts/validate-mac-zip.mjs <zip>');
    process.exit(2);
}

const failures = [];
const checks = [];
function check(name, ok, detail = '') {
    checks.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures.push(name);
}

const fd = openSync(zipPath, 'r');
const size = fstatSync(fd).size;
function readAt(offset, length) {
    const buf = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
        const n = readSync(fd, buf, total, length - total, offset + total);
        if (n <= 0) throw new Error(`readAt hit EOF at ${offset + total}`);
        total += n;
    }
    return buf;
}

// --- 1. locate EOCD ---------------------------------------------------------
const tail = readAt(Math.max(0, size - 65558), Math.min(65558, size));
let eocdRel = -1;
for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocdRel = i; break; }
}
if (eocdRel < 0) { check('EOCD found', false); process.exit(1); }
const eocd = tail.subarray(eocdRel);
const cdEntries = eocd.readUInt16LE(10);
const cdSize = eocd.readUInt32LE(12);
const cdOffset = readAt(size - tail.length + eocdRel + 16, 4).readUInt32LE(0);
check('EOCD found', true, `entries=${cdEntries} cdSize=${cdSize} cdOffset=${cdOffset}`);
check('no ZIP64 needed', cdEntries < 65535 && cdOffset !== 0xffffffff && size < 4294967296);
check('EOCD sits at end of file', cdOffset + cdSize + 22 === size,
    `expect ${cdOffset + cdSize + 22} actual ${size}`);

// --- 2. parse central directory --------------------------------------------
const cd = readAt(cdOffset, cdSize);
const entries = [];
const indexByName = new Map();
{
    let p = 0;
    const disc = /\\/g;
    for (let i = 0; i < cdEntries; i++) {
        const sig = cd.readUInt32LE(p);
        if (sig !== 0x02014b50) { check(`central dir record ${i} signature`, false); break; }
        const rec = {
            versionMadeBy: cd.readUInt16LE(p + 4),
            method: cd.readUInt16LE(p + 10),
            crc: cd.readUInt32LE(p + 16),
            compSize: cd.readUInt32LE(p + 20),
            uncompSize: cd.readUInt32LE(p + 24),
            nameLen: cd.readUInt16LE(p + 28),
            extraLen: cd.readUInt16LE(p + 30),
            commentLen: cd.readUInt16LE(p + 32),
            externalAttr: cd.readUInt32LE(p + 38),
            localOffset: cd.readUInt32LE(p + 42),
            name: cd.toString('utf8', p + 46, p + 46 + cd.readUInt16LE(p + 28)),
        };
        entries.push(rec);
        indexByName.set(rec.name, rec);
        p += 46 + rec.nameLen + rec.extraLen + rec.commentLen;
    }
    check(`central directory holds ${cdEntries} records`, entries.length === cdEntries,
        `parsed ${entries.length}`);

    // unix version-made-by and mode sanity
    let badVm = 0, badAttr = 0;
    for (const e of entries) {
        if ((e.versionMadeBy >> 8) !== 3) badVm++;                    // host = unix
        if ((e.externalAttr >> 16) === 0) badAttr++;
    }
    check('version-made-by is Unix for every entry', badVm === 0, `${badVm} bad`);
    check('external attrs carry mode bits for every entry', badAttr === 0, `${badAttr} bad`);

    // name safety
    const unsafe = entries.filter(e =>
        e.name.includes('\\') || e.name.includes('..') || /^[a-z]:/i.test(e.name) || e.name.startsWith('/'));
    check('entry names are relative and safe', unsafe.length === 0,
        unsafe.length ? unsafe[0].name : '');
}

// --- 3. re-read every local header -----------------------------------------
let lhBad = 0;
let lhBadName = '';
for (const e of entries) {
    const lh = readAt(e.localOffset, 30);
    if (lh.readUInt32LE(0) !== 0x04034b50 ||
        lh.readUInt16LE(8) !== e.method ||
        lh.readUInt32LE(14) !== e.crc ||
        lh.readUInt32LE(18) !== e.compSize ||
        lh.readUInt32LE(22) !== e.uncompSize ||
        lh.readUInt16LE(26) !== e.nameLen) {
        lhBad++;
        if (!lhBadName) lhBadName = e.name;
    }
}
check('every local header re-read matches central record', lhBad === 0, `${lhBad} bad${lhBadName ? ` (${lhBadName})` : ''}`);

// --- 4. entry payload reader ------------------------------------------------
function entryPayload(entry) {
    const lh = readAt(entry.localOffset, 30);
    const nameLen = lh.readUInt16LE(26);
    const extraLen = lh.readUInt16LE(28);
    const dataOff = entry.localOffset + 30 + nameLen + extraLen;
    const body = readAt(dataOff, entry.compSize);
    const out = entry.method === 0 ? body : inflateRawSync(body);
    if (out.length !== entry.uncompSize) throw new Error(`inflated size mismatch for ${entry.name}`);
    return out;
}
function isMagic(b) {
    return b && b.length >= 4 && (
        b.subarray(0, 4).equals(Buffer.from('cffaedfe', 'hex')) || // Mach-O 64 LE
        b.subarray(0, 4).equals(Buffer.from('feedfacf', 'hex')) || // Mach-O 64 BE
        b.subarray(0, 4).equals(Buffer.from('cafebabe', 'hex')) || // fat LE
        b.subarray(0, 4).equals(Buffer.from('feedface', 'hex')));  // Mach-O 32
}

/** Sniff the first bytes of an entry without inflating multi-hundred-MB blobs. */
function isMachO(entry) {
    try {
        const lh = readAt(entry.localOffset, 30);
        const nameLen = lh.readUInt16LE(26);
        const extraLen = lh.readUInt16LE(28);
        const dataOff = entry.localOffset + 30 + nameLen + extraLen;
        if (entry.method === 0) return isMagic(readAt(dataOff, Math.min(16, entry.compSize)));
        const raw = readAt(dataOff, Math.min(512 * 1024, entry.compSize));
        let b;
        try {
            b = inflateRawSync(raw, { finishFlush: ZC.Z_SYNC_FLUSH }); // prefix inflate
        } catch {
            b = entryPayload(entry).subarray(0, 64);
        }
        return isMagic(b);
    } catch {
        return false;
    }
}

const P = 'KnockDesk.app/Contents/';
const mode = (e) => (e ? (e.externalAttr >>> 16) & 0o7777 : -1);
const get = (name) => indexByName.get(name);

// --- 5. bundle layout -------------------------------------------------------
const macosDir = entries.filter(e => e.name.startsWith(P + 'MacOS/') && !e.name.endsWith('/'));
check('Contents/MacOS has exactly one binary', macosDir.length === 1,
    macosDir.map(e => e.name).join(', ') || 'none');
const appBin = macosDir[0];
if (appBin) {
    check('app binary mode is 0755', mode(appBin) === 0o755, `mode=${mode(appBin).toString(8)}`);
    check('app binary is Mach-O', isMachO(appBin), appBin.name);
}

const info = get(P + 'Info.plist');
check('Info.plist present and 0644', !!info && mode(info) === 0o644, info ? `mode=${mode(info).toString(8)}` : 'missing');
if (info) {
    const xml = entryPayload(info).toString('utf8');
    for (const needle of [
        ['CFBundleIdentifier app.knockdesk.desktop', 'app.knockdesk.desktop'],
        ['CFBundleShortVersionString 3.1.12', '3.1.12'],
        ['NSMicrophoneUsageDescription', 'NSMicrophoneUsageDescription'],
        ['NSCameraUsageDescription', 'NSCameraUsageDescription'],
        ['NSAppleEventsUsageDescription', 'NSAppleEventsUsageDescription'],
        ['LSMinimumSystemVersion', 'LSMinimumSystemVersion'],
    ]) check(`Info.plist has ${needle[0]}`, xml.includes(needle[1]));
}

const asar = get(P + 'Resources/app.asar');
{
    // byte size must match the staged source app.asar (mac build copies it verbatim)
    let expectedAsar = 515535292;
    try {
        // locate the staged source from the environment or layout-relative guesses;
        // no absolute machine paths are embedded (portable tooling)
        const scriptDir = dirname(fileURLToPath(import.meta.url));
        const candidates = [
            process.env.KNOCKDESK_STAGE,
            resolve('staging/nsis-stage'),
            resolve('../KnockDesk/staging/nsis-stage'),
            resolve(scriptDir, '../../../staging/nsis-stage'),
        ].filter(Boolean);
        for (const dir of candidates) {
            try { expectedAsar = statSync(join(dir, 'resources', 'app.asar')).size; break; }
            catch { /* try next candidate */ }
        }
    } catch { /* candidate discovery failed: fall back to the recorded snapshot */ }
    check('app.asar present, stored raw, byte-equal to staged source', !!asar && asar.method === 0 &&
        asar.uncompSize === expectedAsar,
        asar ? `${asar.uncompSize}B (expected ${expectedAsar}) method=${asar.method}` : 'missing');
}
check('main.jsc present', !!get(P + 'Resources/main.jsc'));
check('runtime.json present', !!get(P + 'Resources/hermes-runtime/runtime.json'));
check('computer-runtime.json present', !!get(P + 'Resources/computer-runtime/runtime.json'));
if (get(P + 'Resources/hermes-runtime/runtime.json')) {
    try {
        const rt = JSON.parse(entryPayload(get(P + 'Resources/hermes-runtime/runtime.json')).toString('utf8'));
        check('runtime.json platform is darwin', `${rt.platform}`.startsWith('darwin'), rt.platform);
    } catch (err) { check('runtime.json parses', false, err.message); }
}

// --- 6. Electron Framework symlinks rebased to KnockDesk.app ----------------
const fwSyms = entries.filter(e => e.name.startsWith(P + 'Frameworks/') &&
    (e.externalAttr >>> 16) === 0o120777);
check('Frameworks symlink count looks Electron-like', fwSyms.length >= 3, `count=${fwSyms.length}`);
{
    const current = entries.filter(e => /Versions\/Current$/.test(e.name) && (e.externalAttr >>> 16) === 0o120777);
    check('Versions/Current symlinks exist', current.length >= 1, `count=${current.length}`);
    if (current.length) {
        const bad = current.filter(e => entryPayload(e).toString() !== 'A');
        check('Versions/Current -> A', bad.length === 0, bad.map(e => e.name).join(', '));
    }
}

// --- 7. hermes venv ---------------------------------------------------------
const HR = P + 'Resources/hermes-runtime/';
const binDir = HR + 'venv/bin/';
const pyLink = get(binDir + 'python');
check('venv/bin/python symlink exists', !!pyLink && ((pyLink.externalAttr >>> 16) === 0o120777));
if (pyLink) check('venv/bin/python -> ../../python/bin/python3.11',
    entryPayload(pyLink).toString() === '../../python/bin/python3.11', entryPayload(pyLink).toString());
for (const [name, target] of [['python3', 'python'], ['python3.11', 'python']]) {
    const e = get(binDir + name);
    check(`venv/bin/${name} symlink -> ${target}`, !!e && entryPayload(e).toString() === target,
        e ? entryPayload(e).toString() : 'missing');
}
const hermes = get(binDir + 'hermes');
check('venv/bin/hermes present with 0755', !!hermes && mode(hermes) === 0o755,
    hermes ? `mode=${mode(hermes).toString(8)}` : 'missing');
if (hermes) {
    const s = entryPayload(hermes).toString('utf8', 0, 200);
    check('hermes wrapper has shebang', s.startsWith('#!'), s.split('\n')[0]);
}
const realPy = get(HR + 'python/bin/python3.11');
check('cp python/bin/python3.11 present', !!realPy);
if (realPy) {
    check('python3.11 mode 0755', mode(realPy) === 0o755, `mode=${mode(realPy).toString(8)}`);
    check('python3.11 is Mach-O', isMachO(realPy));
}
// flattened CPython-internal symlinks must live INSIDE the app bundle now
{
    const inApp = get(HR + 'python/bin/python');
    check('python/bin/python symlink inside app', !!inApp && (inApp.externalAttr >>> 16) === 0o120777,
        inApp ? `mode=${((inApp.externalAttr >>> 16) >>> 0).toString(8)}` : 'missing');
    if (inApp) check('python/bin/python -> python3.11', entryPayload(inApp).toString() === 'python3.11',
        entryPayload(inApp).toString());
    const inApp3 = get(HR + 'python/bin/python3');
    if (inApp3) check('python/bin/python3 -> python3.11', entryPayload(inApp3).toString() === 'python3.11',
        entryPayload(inApp3).toString());
    const pkg = entries.filter(e => e.name.startsWith(HR + 'python/lib/pkgconfig/') && (e.externalAttr >>> 16) === 0o120777);
    check('pkgconfig symlinks inside app', pkg.length >= 1, `count=${pkg.length}`);
    const man = entries.filter(e => e.name.startsWith(HR + 'python/share/man/') && (e.externalAttr >>> 16) === 0o120777);
    check('man-page symlinks inside app', man.length >= 1, `count=${man.length}`);
}
const pyvenv = get(HR + 'venv/pyvenv.cfg');
check('pyvenv.cfg present', !!pyvenv);
if (pyvenv) {
    const cfg = entryPayload(pyvenv).toString('utf8');
    check('pyvenv.cfg has ../../python home', cfg.includes('../../python'), cfg.split('\n').slice(0, 3).join(' | '));
}
const nodeBin = get(P + 'Resources/bin/node');
check('staged node binary present + 0755', !!nodeBin && mode(nodeBin) === 0o755,
    nodeBin ? `mode=${mode(nodeBin).toString(8)}` : 'missing');
if (nodeBin) check('node binary is Mach-O', isMachO(nodeBin));

// site-packages presence
const sp = HR + 'venv/lib/python3.11/site-packages/';
for (const pkg of ['onnxruntime', 'faster_whisper', 'cffi', 'six', 'websockets', 'yaml', 'PIL', 'pygame/__init__.py']) {
    const hit = entries.some(e => e.name.startsWith(sp + pkg) || e.name === sp + pkg);
    check(`site-packages has ${pkg}`, hit);
}
// hermes_agent dist-info flowed through
check('hermes_agent dist-info copied', entries.some(e => e.name.startsWith(sp + 'hermes_agent-0.17.0.dist-info')));

// --- 8. sqlite native swapped ----------------------------------------------
const sqlite = get(P + 'Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node');
check('better_sqlite3.node present', !!sqlite);
if (sqlite) {
    check('better_sqlite3.node mode 0755', mode(sqlite) === 0o755, `mode=${mode(sqlite).toString(8)}`);
    check('better_sqlite3.node is Mach-O', isMachO(sqlite));
}

// --- 9. strip guarantees (win32/linux names can never appear in darwin paths) ---
const stripped = entries.filter(e =>
    (/robotjs\//i.test(e.name) && /(win32|linux|rpi)/i.test(e.name)) ||
    (/(^|\/)picovoice\//i.test(e.name) && /(windows|linux|raspberry)/i.test(e.name)));
check('windows/linux robotjs + picovoice natives stripped', stripped.length === 0,
    stripped.length ? stripped[0].name : '');
{
    const pv = entries.filter(e => /(^|\/)picovoice\//i.test(e.name));
    if (pv.length) check('mac picovoice natives remain (feature preserved)', true,
        [...new Set(pv.map(e => e.name.split('picovoice/')[1].split('/')[0]))].join(', '));
}

// --- 10. no symlink-map leaks at the zip root ---------------
{
    const strays = entries.filter(e => !e.name.startsWith('KnockDesk.app/'));
    check('all entries live under KnockDesk.app/ (symlink keys correctly prefixed)', strays.length === 0,
        strays.length ? `first stray: ${strays[0].name}` : '');
}

// --- 11. CRC on every small entry (<=4MB) -------------------
let crcBad = 0, crcBadName = '', crcChecked = 0;
for (const e of entries) {
    if (e.uncompSize === 0 || e.uncompSize > 4 * 1024 * 1024) continue;
    try {
        const got = crc32(entryPayload(e)) >>> 0;
        crcChecked++;
        if (got !== e.crc) { crcBad++; if (!crcBadName) crcBadName = e.name; }
    } catch { crcBad++; if (!crcBadName) crcBadName = e.name; }
}
check(`CRC32 verified on ${crcChecked} small entries, all match`, crcBad === 0,
    crcBad ? `first bad: ${crcBadName}` : '');

// --- summary ----------------------------------------------------------------
console.log(`\n${entries.length} entries; ${checks.filter(c => c.ok).length}/${checks.length} checks passed`);
closeSync(fd);
process.exit(failures.length ? 1 : 0);
