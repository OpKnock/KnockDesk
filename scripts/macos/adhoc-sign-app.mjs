/**
 * Ad-hoc sign a cross-built KnockDesk.app before it is zipped.
 *
 * The macOS build assembles an Electron bundle on Windows. Electron's
 * original signature becomes stale as soon as resources are replaced, and
 * the rewritten bundle has no top-level _CodeSignature. macOS reports that
 * bundle as "damaged and can't be opened". rcodesign can create a fresh
 * ad-hoc signature, but it needs the Unix symlinks from the final zip to
 * exist on disk while it seals the bundle.
 *
 * This helper materialises those symlinks temporarily (Windows mklink),
 * signs the whole .app recursively, then removes the links so the zip
 * writer can put them back with their original Unix target strings.
 * rcodesign normalises Windows backslash targets to '/' in CodeResources.
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Framework link names whose targets are directories, not files.
const DIRECTORY_LINK_NAMES = new Set([
    'Resources', 'Current', 'Libraries', 'Helpers', 'Headers',
]);

const FRAMEWORK_PLIST = join(
    'KnockDesk.app', 'Contents', 'Frameworks',
    'Electron Framework.framework', 'Resources', 'Info.plist');

function quote(value) {
    return '"' + String(value).replaceAll('"', '\\"') + '"';
}

function removeExistingLink(local) {
    if (!existsSync(local) && !isBrokenSymlink(local)) return;
    const stat = lstatSync(local);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
        throw new Error(
            'refusing to replace a real directory with a symlink: ' + local);
    }
    rmSync(local, { recursive: false, force: true });
}

function isBrokenSymlink(local) {
    try {
        return lstatSync(local).isSymbolicLink();
    } catch {
        return false;
    }
}

function linkIsForDirectory(local, target) {
    return DIRECTORY_LINK_NAMES.has(basename(local)) ||
        DIRECTORY_LINK_NAMES.has(basename(String(target).replaceAll('\\', '/')));
}

/**
 * @param {string} appRoot directory that contains KnockDesk.app
 * @param {Map<string,string>|Record<string,string>} symlinks zip-relative path -> target
 * @param {string} rcodesign path to rcodesign, or a name on PATH
 */
export function adhocSignApp(appRoot, symlinks, rcodesign) {
    const root = resolve(appRoot);
    const appPath = join(root, 'KnockDesk.app');
    if (!existsSync(join(appPath, 'Contents', 'Info.plist'))) {
        throw new Error('not a valid .app bundle: ' + appPath);
    }
    if (!symlinks || (symlinks.size ?? Object.keys(symlinks).length) === 0) {
        throw new Error('symlink map is empty; refusing to sign an incomplete seal');
    }

    // Fail before touching anything if the signer is missing.
    execFileSync(rcodesign, ['--version'], { stdio: 'ignore' });

    const entries = symlinks instanceof Map
        ? [...symlinks.entries()]
        : Object.entries(symlinks);
    const created = [];
    try {
        for (const [rel, target] of entries) {
            const local = join(root, ...rel.split('/'));
            removeExistingLink(local);
            mkdirSync(dirname(local), { recursive: true });
            const flag = linkIsForDirectory(local, target) ? '/D ' : '';
            // Windows symlinks only resolve when target separators are '\'.
            // rcodesign writes '/' back into CodeResources, which is what
            // macOS expects after the zip is extracted.
            const winTarget = String(target).replaceAll('/', '\\');
            execSync(
                `cmd /c mklink ${flag}${quote(local)} ${quote(winTarget)}`,
                { stdio: 'pipe' });
            created.push(local);
        }

        if (entries.some(([rel]) => rel.startsWith('KnockDesk.app/Contents/Frameworks/'))) {
            const probe = join(root, FRAMEWORK_PLIST);
            if (!existsSync(probe)) {
                throw new Error('framework symlink chain did not resolve: ' + probe);
            }
        }

        console.log('[sign] ad-hoc signing', appPath);
        execFileSync(rcodesign, ['sign', appPath], { stdio: 'inherit' });
        console.log('[sign] signature seal written');
    } finally {
        for (const local of created) {
            try {
                rmSync(local, { recursive: false, force: true });
            } catch (err) {
                console.warn('[sign] cleanup warning:', local, err.message);
            }
        }
    }
}

export default adhocSignApp;

// CLI: node adhoc-sign-app.mjs <appRoot> <symlink-map.json> <rcodesign>
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [appRoot, mapPath, rcodesign] = process.argv.slice(2);
    if (!appRoot || !mapPath || !rcodesign) {
        console.error(
            'usage: node adhoc-sign-app.mjs <appRoot> <symlink-map.json> <rcodesign>');
        process.exit(2);
    }
    const raw = JSON.parse(readFileSync(mapPath, 'utf8'));
    adhocSignApp(appRoot, new Map(Object.entries(raw)), rcodesign);
}
