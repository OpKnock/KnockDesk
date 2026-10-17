/**
 * KnockDesk macOS build pipeline — runs entirely on Windows.
 *
 * Assembles KnockDesk.app for Apple Silicon and Intel from the packaged
 * Windows payload (staging/nsis-stage), replacing Windows-only runtime
 * pieces with their Darwin equivalents:
 *
 *   - Electron 44.7.2 darwin runtime (arm64 / x64) from official releases
 *   - CPython 3.11 from python-build-standalone (install_only tarball)
 *   - Hermes venv rebuilt from macOS wheels (same pins as the Windows venv)
 *   - better-sqlite3 native module swapped for the electron-v132 darwin prebuild
 *   - bundled bin/node swapped for a Darwin Node 22 binary
 *   - Info.plist: bundle name/id/icon, version, usage descriptions
 *   - icns icon generated from the app's own 512px icon
 *
 * Cross-OS constraints handled here: Unix file modes and symlinks are baked
 * into the final zip (scripts/zip-with-mode.mjs) so macOS extracts a runnable
 * bundle; Windows-only helpers (python-embedded, swap-helper.exe, elevate.exe,
 * agent-browser.exe, browsers/) are not shipped.
 *
 * Usage: node scripts/build-macos.mjs [--arch arm64|x64|both]
 */
import {
    cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync,
} from 'node:fs';
import { join, resolve, basename, dirname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { zipDirectory } from './zip-with-mode.mjs';
import { buildIcns } from './icns.mjs';
import { extractZip, extractTarGz, rebaseSymlinks } from './unpack.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const KNOCKDESK = resolve(ROOT, '..', 'KnockDesk');
const STAGE = join(KNOCKDESK, 'staging', 'nsis-stage');
const VENV_PY_WIN = join(KNOCKDESK, 'resources', 'hermes-runtime', 'venv', 'Scripts', 'python.exe');
const WIN_SITE = join(KNOCKDESK, 'resources', 'hermes-runtime', 'venv', 'Lib', 'site-packages');
const ICON_SRC = join(KNOCKDESK, 'resources', 'hermes-runtime', 'src', 'electron', 'pwa', 'icon-512.png');

const APP_VERSION = '3.1.12';
const ELECTRON_VERSION = '44.7.2';
const NODE_VERSION = '22.11.0';
const SQLITE_VERSION = '12.11.1';
const SQLITE_ABI = 132;      // Electron 44 ABI (see robotjs prebuilds/win32-x64-132 in the payload)
const BUNDLE_ID = 'app.knockdesk.desktop';

const DOWNLOADS = join(ROOT, 'downloads');
const WORK = join(ROOT, 'staging');
const DIST = join(ROOT, 'dist');

const argv = process.argv.slice(2);
const archArg = argv.includes('--arch') ? argv[argv.indexOf('--arch') + 1] : 'both';
const ARCHES = archArg === 'both' ? ['arm64', 'x64'] : [archArg];

const log = (...a) => console.log('[build]', ...a);

// ── download helpers (retry transient 5xx/429/network failures) ─────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

async function fetchWithRetry(url, attempts = 5) {
    let lastErr = null;
    for (let i = 1; i <= attempts; i++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'knockdesk-macos-build' } });
            if (res.ok) return res;
            lastErr = new Error(`${res.status} ${url}`);
            if (!RETRYABLE.has(res.status)) throw lastErr; // 404 etc: fail fast
            log(`HTTP ${res.status} (attempt ${i}/${attempts}), retrying in ${i * 5}s...`);
        } catch (err) {
            if (err === lastErr) throw err; // non-retryable HTTP status already logged
            lastErr = err;
            log(`fetch error "${String(err?.cause?.code || err?.message || err)}" (attempt ${i}/${attempts}), retrying in ${i * 5}s...`);
        }
        await sleep(i * 5000);
    }
    throw lastErr ?? new Error('unreachable: ' + url);
}

async function fetchBuffer(url) {
    const res = await fetchWithRetry(url);
    return Buffer.from(await res.arrayBuffer());
}

async function download(url, dest) {
    if (existsSync(dest) && statSync(dest).size > 0) {
        log('cached:', basename(dest));
        return dest;
    }
    mkdirSync(dirname(dest), { recursive: true });
    const res = await fetchWithRetry(url);
    if (!res.body) throw new Error(`download failed (empty body): ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buf);
    log('downloaded:', basename(dest), (buf.length / 1048576).toFixed(1) + 'MB');
    return dest;
}

async function githubRelease(repo, tag = null) {
    const url = tag
        ? `https://api.github.com/repos/${repo}/releases/tags/${tag}`
        : `https://api.github.com/repos/${repo}/releases/latest`;
    return JSON.parse((await fetchBuffer(url)).toString('utf8'));
}

// ── process helpers ──────────────────────────────────────────────────────────
function run(cmd, args, opts = {}) {
    log('>', cmd, args.join(' '));
    execFileSync(cmd, args, {
        stdio: 'inherit',
        shell: false,
        ...opts,
        env: { ...process.env, ...(opts.env || {}) },
    });
}

function extractZipWithPS() { throw new Error('removed'); }

function sha256(file) {
    const h = createHash('sha256');
    h.update(readFileSync(file));
    return h.digest('hex').toUpperCase();
}

// ── Info.plist ───────────────────────────────────────────────────────────────
const USAGE_KEYS = `
  <key>NSAccessibilityUsageDescription</key>
  <string>KnockDesk needs Accessibility access to move the cursor and type on your behalf when you ask it to control the computer.</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>KnockDesk uses the microphone for the wake word and voice input.</string>
  <key>NSCameraUsageDescription</key>
  <string>KnockDesk uses the camera for face presence features. Recording never starts without your action.</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>KnockDesk captures the screen so the assistant can read and control apps you point it at.</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>KnockDesk sends Apple events to control other apps when you ask it to automate them.</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
`;

function patchPlist(plistPath, { iconFile }) {
    let xml = readFileSync(plistPath, 'utf8');
    if (!xml.trimStart().startsWith('<')) {
        throw new Error('Info.plist is binary; expected XML from the Electron zip');
    }
    const set = (key, value) => {
        const re = new RegExp(String.raw`<key>${key}</key>\s*<string>[^<]*</string>`);
        const v = `<key>${key}</key>\n  <string>${value}</string>`;
        if (re.test(xml)) xml = xml.replace(re, v);
        else xml = xml.replace(/\n\s*<key>CFBundleInfoDictionaryVersion<\/key>/, `\n  ${v}\n  <key>CFBundleInfoDictionaryVersion</key>`);
    };
    set('CFBundleName', 'KnockDesk');
    set('CFBundleExecutable', 'KnockDesk');
    set('CFBundleIdentifier', BUNDLE_ID);
    set('CFBundleIconFile', iconFile);
    set('CFBundleShortVersionString', APP_VERSION);
    if (!xml.includes('CFBundleDisplayName')) {
        xml = xml.replace(/\n\s*<key>CFBundleName<\/key>/, '\n  <key>CFBundleDisplayName</key>\n  <string>KnockDesk</string>\n  <key>CFBundleName</key>');
    } else {
        xml = xml.replace(new RegExp(String.raw`<key>CFBundleDisplayName</key>\s*<string>[^<]*</string>`), '<key>CFBundleDisplayName</key>\n  <string>KnockDesk</string>');
    }
    xml = xml.replace(/<\/dict>\s*<\/plist>/, `${USAGE_KEYS}</dict>\n</plist>`);
    xml = xml.replace(/<key>CFBundleShortVersionString<\/key>\s*<string>[^<]*<\/string>/, `<key>CFBundleShortVersionString</key>\n  <string>${APP_VERSION}</string>`);
    if (xml.includes('CFBundleVersion')) {
        xml = xml.replace(/<key>CFBundleVersion<\/key>\s*<string>[^<]*<\/string>/, `<key>CFBundleVersion</key>\n  <string>${APP_VERSION}</string>`);
    } else {
        xml = xml.replace(/<key>CFBundleShortVersionString<\/key>/, `<key>CFBundleVersion</key>\n  <string>${APP_VERSION}</string>\n  <key>CFBundleShortVersionString</key>`);
    }
    writeFileSync(plistPath, xml);
}

// ── hermes runtime assembly ─────────────────────────────────────────────────
async function findPbsRelease() {
    log('resolving python-build-standalone release (3.11.x)...');
    // Walk releases one at a time — the multi-release list endpoint 504s
    // because each PBS release carries ~2000 assets.
    const isAsset = (n, arch) => n.startsWith('cpython-3.11.') && n.endsWith(`-${arch}-apple-darwin-install_only.tar.gz`);
    for (let page = 1; page <= 6; page++) {
        const rels = JSON.parse(
            (await fetchBuffer(`https://api.github.com/repos/astral-sh/python-build-standalone/releases?per_page=1&page=${page}`)).toString('utf8'),
        );
        if (!rels.length) break;
        const rel = rels[0];
        const assets = rel.assets.map((a) => a.name);
        const arm64 = assets.find((n) => isAsset(n, 'aarch64'));
        const x64 = assets.find((n) => isAsset(n, 'x86_64'));
        if (arm64 && x64) {
            const urls = {
                arm64: rel.assets.find((a) => a.name === arm64).browser_download_url,
                x64: rel.assets.find((a) => a.name === x64).browser_download_url,
            };
            const version = arm64.match(/cpython-(3\.11\.\d+)\+/)?.[1];
            log('pbs release:', rel.tag_name, 'python', version);
            return { tag: rel.tag_name, urls, version };
        }
        log(`page ${page}: ${rel.tag_name} lacks 3.11 darwin assets, trying next release`);
    }
    throw new Error('no python-build-standalone 3.11 darwin release found');
}

async function buildVenv(destRoot, archTagList, wheelsDir, uvPlatform, pythonVersion) {
    // 1. resolve the dependency closure WITH markers evaluated for the target
    //    platform. pip evaluates markers against the RUNNING interpreter, so a
    //    plain `pip download` on Windows aborts on e.g. portalocker's
    //    `pywin32; platform_system == "Windows"` transitive requirement. uv can
    //    compile for a foreign platform, producing explicit `name==version`
    //    pins; the subsequent `pip download --no-deps` then needs no resolution
    //    at all and every pin is fetched as a wheel for the mac platform tags.
    //
    //    MACOSX_DEPLOYMENT_TARGET picks which wheel tags count as compatible:
    //    Apple-Silicon ML wheels (onnxruntime, av) are tagged macosx_14_0 only,
    //    and Intel onnxruntime only ships macosx_13_0_universal2 — so VAD /
    //    transcription / av media decoding degrade to macOS 14+ (AS) and
    //    13+ (Intel), matching the wake-word policy: heavy ML degrades, the
    //    core app still targets 11.0.
    const reqFile = join(ROOT, 'requirements-darwin.txt');
    const uvExe = join(DOWNLOADS, 'uv.exe');
    if (!existsSync(uvExe)) throw new Error('downloads/uv.exe missing (self-contained resolver)');

    // Some releases stopped publishing Intel-mac wheels; substitute the newest
    // Intel-compatible release for those packages only (per-arch resolution).
    const PY_PIN_OVERRIDES = {
        'x86_64-apple-darwin': {
            onnxruntime: '1.22.1',
            // cryptography dropped Intel-mac wheels after 48.x (49.0.0 is
            // arm64-only); 48.0.1 is the newest release with x64 mac wheels.
            cryptography: '48.0.1',
        },
    };
    const pins_in = Object.entries(PY_PIN_OVERRIDES[uvPlatform] || {});
    let compileReq = reqFile;
    if (pins_in.length) {
        compileReq = join(WORK, `requirements-darwin-${uvPlatform}.txt`);
        const base = readFileSync(reqFile, 'utf8');
        const overridden = new Set(pins_in.map(([k]) => k.toLowerCase().replaceAll('_', '-')));
        const lines = base.split('\n').map((l) => {
            const key = l.split('==')[0].trim().toLowerCase().replaceAll('_', '-');
            return overridden.has(key) ? null : l;
        });
        for (const [k, v] of pins_in) {
            if (!new RegExp(`^${k.replace(/-/g, '[-_]')}([=<>]|\s)`, 'im').test(base)) {
                throw new Error(`override target not pinned in requirements: ${k}`);
            }
            lines.push(`${k}==${v}`);
        }
        writeFileSync(compileReq, lines.filter((l) => l !== null).join('\n'));
    }

    const deployTarget = uvPlatform === 'aarch64-apple-darwin' ? '14.0' : '13.0';
    const resolved = join(WORK, `resolved-${uvPlatform}.txt`);
    rmSync(resolved, { force: true });
    run(uvExe, [
        'pip', 'compile', compileReq,
        '--python-platform', uvPlatform,
        '--python-version', pythonVersion,
        '--no-header', '--no-annotate',
        // resolve wheels only — sdists would pin versions that have no wheel
        // and the later `pip download --only-binary :all:` would then fail.
        '--no-build',
        '-o', resolved,
    ], { env: { MACOSX_DEPLOYMENT_TARGET: deployTarget } });
    const pins = readFileSync(resolved, 'utf8').split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
    if (!pins.length) throw new Error('uv pip compile produced no pins');
    log('resolved pins:', pins.length);

    // 2. download the wheels for the target arch (explicit pins, --no-deps)
    rmSync(wheelsDir, { recursive: true, force: true });
    const platformArgs = archTagList.flatMap((p) => ['--platform', p]);
    run(VENV_PY_WIN, [
        '-m', 'pip', 'download', '--disable-pip-version-check',
        '--no-deps',
        '-r', resolved,
        ...platformArgs,
        '--python-version', '3.11',
        '--implementation', 'cp',
        '--abi', 'cp311', '--abi', 'abi3', '--abi', 'none',
        '--only-binary', ':all:',
        '-d', wheelsDir,
    ]);
    const wheels = readdirSync(wheelsDir).filter((f) => f.endsWith('.whl'));
    if (!wheels.length) throw new Error('no wheels downloaded');
    log('wheels:', wheels.length);

    // 2. unpack into site-packages (venv/bin/python etc. live only in the
    //    zip's symlink map — no NTFS symlinks are created on disk)
    const venvRoot = join(destRoot, 'venv');
    const site = join(venvRoot, 'lib', 'python3.11', 'site-packages');
    rmSync(venvRoot, { recursive: true, force: true });
    mkdirSync(site, { recursive: true });
    mkdirSync(join(venvRoot, 'bin'), { recursive: true });
    const unpackScript = `
import zipfile, pathlib, sys
target = pathlib.Path(sys.argv[2])
for w in sorted(pathlib.Path(sys.argv[1]).glob('*.whl')):
    with zipfile.ZipFile(w) as z:
        z.extractall(target)
print('unpacked', len(list(pathlib.Path(sys.argv[1]).glob('*.whl'))), 'wheels')
`;
    const unpackFile = join(WORK, 'unpack-wheels.py');
    writeFileSync(unpackFile, unpackScript);
    run(VENV_PY_WIN, [unpackFile, wheelsDir, site]);

    // 3. hermes_agent dist-info (metadata for importlib.metadata)
    const distName = readdirSync(WIN_SITE).find((d) => d.startsWith('hermes_agent-') && d.endsWith('.dist-info'));
    if (distName) {
        cpSync(join(WIN_SITE, distName), join(site, distName), { recursive: true });
        rmSync(join(site, distName, 'direct_url.json'), { force: true });
        log('copied', distName);
    }

    // 4. src on sys.path via .pth (relative depth: site-packages -> python3.11 -> lib -> venv -> hermesRoot)
    writeFileSync(join(site, '_hermes_src.pth'), '../../../../src\n');

    // 5. pyvenv.cfg (home is rewritten at first run by hermes-runtime.js)
    writeFileSync(join(venvRoot, 'pyvenv.cfg'), [
        'home = ../../python',
        'implementation = CPython',
        'version = 3.11',
        'include-system-site-packages = false',
        '',
    ].join('\n'));

    // 6. venv/bin/hermes launcher (shell wrapper; exec bit applied at zip time)
    const hermesSh = [
        '#!/bin/sh',
        '# KnockDesk bundled Hermes launcher (relocatable).',
        'DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)',
        'exec "$DIR/python" -c \'import re, sys; from hermes_cli.main import main; sys.argv[0] = re.sub(r"(-script\\.pyw|\\.exe)?$", "", sys.argv[0]); sys.exit(main())\' "$@"',
        '',
    ].join('\n');
    writeFileSync(join(venvRoot, 'bin', 'hermes'), hermesSh);
    return site;
}

// ── resource copying ────────────────────────────────────────────────────────
const RESOURCES_TO_COPY = [
    'agent-town-dist', 'audio', 'computer-runtime', 'hermes-plugins',
    'knockdesk-computer', 'public', 'videos', 'wake_word_bg.py',
    'app-update.yml', 'knockdesk-gen.marker',
];

const UNPACKED_STRIP = [
    'node_modules/@jitsi/robotjs/bin',
    'node_modules/@jitsi/robotjs/build',
    'node_modules/@jitsi/robotjs/prebuilds/win32-arm64',
    'node_modules/@jitsi/robotjs/prebuilds/win32-ia32',
    'node_modules/@jitsi/robotjs/prebuilds/win32-x64',
    'node_modules/@jitsi/robotjs/prebuilds/linux-arm64',
    'node_modules/@jitsi/robotjs/prebuilds/linux-x64',
    'node_modules/@napi-rs/canvas/node_modules/@napi-rs/canvas-win32-x64-msvc',
    'node_modules/@picovoice/porcupine-node/lib/windows',
    'node_modules/@picovoice/porcupine-node/lib/linux',
    'node_modules/@picovoice/porcupine-node/lib/raspberry-pi',
    'node_modules/@picovoice/pvrecorder-node/lib/windows',
    'node_modules/@picovoice/pvrecorder-node/lib/linux',
    'node_modules/@picovoice/pvrecorder-node/lib/raspberry-pi',
];

// ── main build ──────────────────────────────────────────────────────────────
async function main() {
    log('workspace:', ROOT);
    if (!existsSync(STAGE)) throw new Error('Windows stage missing: ' + STAGE);

    const pbs = await findPbsRelease();
    const sums = [];
    mkdirSync(DOWNLOADS, { recursive: true });
    mkdirSync(WORK, { recursive: true });

    // shared: wheels for both arches (single pass, distinct dirs)
    const platformTags = {
        arm64: ['macosx_11_0_arm64', 'macosx_12_0_arm64', 'macosx_13_0_arm64', 'macosx_14_0_arm64', 'macosx_15_0_arm64', 'macosx_10_13_universal2', 'macosx_10_9_universal2', 'macosx_11_0_universal2'],
        x64: ['macosx_10_9_x86_64', 'macosx_10_13_x86_64', 'macosx_10_15_x86_64', 'macosx_11_0_x86_64', 'macosx_12_0_x86_64', 'macosx_13_0_x86_64', 'macosx_14_0_x86_64', 'macosx_10_9_universal2', 'macosx_10_13_universal2', 'macosx_11_0_universal2'],
    };

    // pre-fetch shared downloads once
    const sqliteRelease = await githubRelease('WiseLibs/better-sqlite3', `v${SQLITE_VERSION}`);
    for (const arch of ARCHES) {
        const eUrl = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-darwin-${arch}.zip`;
        await download(eUrl, join(DOWNLOADS, `electron-v${ELECTRON_VERSION}-darwin-${arch}.zip`));
        await download(`https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${arch}.tar.gz`, join(DOWNLOADS, `node-v${NODE_VERSION}-darwin-${arch}.tar.gz`));
        await download(pbs.urls[arch], join(DOWNLOADS, pbs.urls[arch].split('/').pop()));
        const sqlAsset = sqliteRelease.assets.find((a) => a.name === `better-sqlite3-v${SQLITE_VERSION}-electron-v${SQLITE_ABI}-darwin-${arch}.tar.gz`);
        if (!sqlAsset) throw new Error(`better-sqlite3 electron-v${SQLITE_ABI} darwin-${arch} prebuild missing`);
        await download(sqlAsset.browser_download_url, join(DOWNLOADS, sqlAsset.name));
    }

    // icon
    const icnsPath = join(WORK, 'KnockDesk.icns');
    if (!existsSync(icnsPath)) buildIcns(ICON_SRC, icnsPath);
    log('icon ready');

    for (const arch of ARCHES) {
        log(`=== arch ${arch} ===`);
        const appRoot = join(WORK, arch, 'KnockDesk.app');
        const resDir = join(appRoot, 'Contents', 'Resources');
        rmSync(join(WORK, arch), { recursive: true, force: true });
        mkdirSync(join(WORK, arch), { recursive: true });

        // 1. electron runtime (symlinks inside .framework bundles come back
        //    in a map — no NTFS symlink privilege needed)
        const extractDir = join(WORK, arch, '_electron');
        const electronSymlinks = extractZip(join(DOWNLOADS, `electron-v${ELECTRON_VERSION}-darwin-${arch}.zip`), extractDir);
        cpSync(join(extractDir, 'Electron.app'), appRoot, { recursive: true });
        rmSync(extractDir, { recursive: true, force: true });

        const macosDir = join(appRoot, 'Contents', 'MacOS');
        cpSync(join(macosDir, 'Electron'), join(macosDir, 'KnockDesk'));
        rmSync(join(macosDir, 'Electron'), { force: true });
        patchPlist(join(appRoot, 'Contents', 'Info.plist'), { iconFile: 'KnockDesk.icns' });
        // icon
        cpSync(icnsPath, join(resDir, 'KnockDesk.icns'));
        const rebasedElectron = rebaseSymlinks(electronSymlinks, 'Electron.app', 'KnockDesk.app');

        // 2. app payload from the Windows stage
        for (const item of RESOURCES_TO_COPY) {
            const src = join(STAGE, 'resources', item);
            if (existsSync(src)) cpSync(src, join(resDir, item), { recursive: true });
        }
        cpSync(join(STAGE, 'resources', 'app.asar'), join(resDir, 'app.asar'));
        cpSync(join(STAGE, 'resources', 'main.jsc'), join(resDir, 'main.jsc'));

        // 3. unpacked natives (mirror) + strip win/linux + swap better-sqlite3
        cpSync(join(STAGE, 'resources', 'app.asar.unpacked'), join(resDir, 'app.asar.unpacked'), { recursive: true });
        for (const rel of UNPACKED_STRIP) {
            rmSync(join(resDir, 'app.asar.unpacked', rel), { recursive: true, force: true });
        }
        extractTarGz(join(DOWNLOADS, `better-sqlite3-v${SQLITE_VERSION}-electron-v${SQLITE_ABI}-darwin-${arch}.tar.gz`), join(WORK, arch, '_sqlite'));
        const sqliteNode = join(resDir, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
        const unpackedSqlite = join(WORK, arch, '_sqlite');
        const sqliteFound = findFile(unpackedSqlite, 'better_sqlite3.node');
        if (!sqliteFound) throw new Error('darwin better_sqlite3.node not found in prebuild tarball');
        cpSync(sqliteFound, sqliteNode);
        rmSync(join(WORK, arch, '_sqlite'), { recursive: true, force: true });
        log('better-sqlite3 swapped for darwin prebuild');

        // 4. bundled node for Hermes PATH / whatsapp bridge
        extractTarGz(join(DOWNLOADS, `node-v${NODE_VERSION}-darwin-${arch}.tar.gz`), join(WORK, arch, '_node'));
        const nodeBin = findFile(join(WORK, arch, '_node'), 'node');
        mkdirSync(join(resDir, 'bin'), { recursive: true });
        cpSync(nodeBin, join(resDir, 'bin', 'node'));
        rmSync(join(WORK, arch, '_node'), { recursive: true, force: true });
        log('bin/node staged');

        // 5. hermes runtime: python (extracted in place; its internal symlinks
        //    come back in a map and are re-baked at zip time)
        const hermesRoot = join(resDir, 'hermes-runtime');
        mkdirSync(hermesRoot, { recursive: true });
        const pyTar = join(DOWNLOADS, pbs.urls[arch].split('/').pop());
        const pyDir = join(hermesRoot, 'python');
        mkdirSync(pyDir, { recursive: true });
        const pySymlinks = extractTarGz(pyTar, pyDir);
        // install_only tarballs may nest a single root dir — flatten if so.
        // The symlink map comes back relative to pyDir (still carrying the
        // nested folder prefix); it is flattened the same way and then rebased
        // with the FULL zip-name prefix (KnockDesk.app/Contents/...).
        const entries0 = readdirSync(pyDir);
        const flattened = entries0.length === 1 && statSync(join(pyDir, entries0[0])).isDirectory();
        if (flattened) {
            const nested = join(pyDir, entries0[0]);
            for (const n of readdirSync(nested)) {
                cpSync(join(nested, n), join(pyDir, n), { recursive: true });
            }
            rmSync(nested, { recursive: true, force: true });
        }
        // Map keys are relative to WORK/<arch> — the same key-space the final
        // zip walk uses — so rebasing must include the app-bundle prefix:
        // KnockDesk.app/Contents/Resources/hermes-runtime/python/<rest>
        const pythonPrefix = relFrom(join(WORK, arch), pyDir).replace(/\\/g, '/');
        const rebasedPython = rebaseSymlinks(pySymlinks, flattened ? `${entries0[0]}/` : null, pythonPrefix);
        if (!existsSync(join(pyDir, 'bin', 'python3.11'))) {
            throw new Error('python-build-standalone extraction produced no bin/python3.11 — tar format parsing failed');
        }

        // 6. hermes runtime: venv from macOS wheels
        await buildVenv(hermesRoot, platformTags[arch], join(WORK, 'wheels-' + arch), arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin', pbs.version);

        // 7. hermes runtime: src (python + hermes sources; node_modules is Windows dev-only)
        cpSync(join(STAGE, 'resources', 'hermes-runtime', 'src'), join(hermesRoot, 'src'), {
            recursive: true,
            filter: (src) => !/node_modules$/.test(src) && !/__pycache__$/.test(src),
        });

        // 8. runtime.json (same schema as Windows; layoutVersion 2)
        writeFileSync(join(hermesRoot, 'runtime.json'), JSON.stringify({
            builtAt: new Date().toISOString(),
            layoutVersion: 2,
            uvVersion: null,
            pythonVersion: '3.11',
            platform: `darwin-${arch}`,
            buildHost: 'windows (cross-built, no macOS machine)',
            buildSrcDir: 'staging/nsis-stage/resources/hermes-runtime/src',
        }, null, 2) + '\n');

        // 9. symlink map for the final zip: framework internals (from the
        //    electron zip) + CPython internals + the venv launchers (which are
        //    never created on disk)
        const symlinks = new Map(rebasedElectron);
        for (const [k, v] of rebasedPython) symlinks.set(k, v);
        // venv launchers are never created on disk; same full key-space as above
        const venvBinPrefix = relFrom(join(WORK, arch), join(hermesRoot, 'venv', 'bin')).replace(/\\/g, '/');
        symlinks.set(`${venvBinPrefix}/python`, '../../python/bin/python3.11');
        symlinks.set(`${venvBinPrefix}/python3`, 'python');
        symlinks.set(`${venvBinPrefix}/python3.11`, 'python');

        // 10. zip (unix modes baked in)
        const zipOut = join(DIST, `KnockDesk-${APP_VERSION}-macOS-${arch}.zip`);
        const { entries, bytes } = zipDirectory(join(WORK, arch), zipOut, { symlinks });
        const size = (bytes / 1073741824).toFixed(2) + ' GB';
        log(`zip done: ${basename(zipOut)} — ${entries} entries, ${size}`);
        sums.push({ file: basename(zipOut), arch, sha256: sha256(zipOut), bytes });
    }

    // manifest
    writeFileSync(join(DIST, 'SHA256SUMS.txt'), sums.map((s) => `${s.sha256}  ${s.file}`).join('\n') + '\n');
    writeFileSync(join(DIST, 'build-manifest.json'), JSON.stringify({
        version: APP_VERSION,
        electron: ELECTRON_VERSION,
        node: NODE_VERSION,
        python: pbs.version,
        pbsTag: pbs.tag,
        betterSqlite3: `${SQLITE_VERSION} (electron-v${SQLITE_ABI})`,
        bundleId: BUNDLE_ID,
        minMacOS: '11.0',
        artifacts: sums,
        builtAt: new Date().toISOString(),
    }, null, 2) + '\n');
    log('dist manifest written');
    sums.forEach((s) => log(s.file, s.sha256));
}

function relFrom(base, abs) {
    return relative(base, abs).split('\\').join('/');
}

function findFile(dir, name) {
    const queue = [dir];
    while (queue.length) {
        const cur = queue.shift();
        for (const item of readdirSync(cur, { withFileTypes: true })) {
            const abs = join(cur, item.name);
            if (item.isDirectory()) queue.push(abs);
            else if (item.name === name) return abs;
        }
    }
    return null;
}

main().catch((err) => {
    console.error('[build] FAILED:', err.message);
    process.exit(1);
});
