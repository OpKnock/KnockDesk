#!/usr/bin/env node
/**
 * Build the KnockDesk MSIX package.
 *
 * The layout is the Electron runtime plus the app's own resources, taken
 * from the staging tree that the NSIS installer uses, so both packages
 * ship exactly the same payload: the asar, the unpacked native modules,
 * the Python and Hermes runtimes, the browsers, the locales and the audio.
 *
 * The store icons are generated from the master mark, so the Store listing
 * shows the KnockDesk mark rather than a placeholder.
 *
 * Usage:
 *   node scripts/build-msix.mjs                 build the package
 *   node scripts/build-msix.mjs --assets-only   regenerate the icons only
 *   node scripts/build-msix.mjs --skip-sign     build without signing
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(ROOT, 'staging', 'nsis-stage');
const LAYOUT = path.join(ROOT, 'staging', 'msix-layout');
const ASSETS = path.join(ROOT, 'staging', 'msix-assets');
const ICON = path.join(ROOT, 'staging', 'nsis-assets', 'install.ico');
const MASTER = path.join(ROOT, 'resources', 'public', 'knockdesk-logo-1024.png');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const args = process.argv.slice(2);
const ASSETS_ONLY = args.includes('--assets-only');
const SKIP_SIGN = args.includes('--skip-sign');

const OUT = path.join(ROOT, 'dist', `KnockDesk-${VERSION}-x64.msix`);
const MAKEAPPX = process.env.MAKEAPPX ||
  'C:/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64/makeappx.exe';
const SIGNTOOL = process.env.SIGNTOOL ||
  'C:/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64/signtool.exe';

// The publisher must match the signing certificate's subject exactly, or
// the package will not install: the signature is checked against it.
const PUBLISHER = 'C=IN, O=N/A, CN=Mehul Wagde, E=wagdemehul@gmail.com';

// ---------------------------------------------------------------- layout ---
// The same exclusions the NSIS installer applies. __pycache__ and .pyc
// files are build noise: 6,600 of them, and the runtime never reads them.
const EXCLUDE_DIRS = new Set(['__pycache__', 'ensurepip', 'app.asar.extracted']);
const EXCLUDE_FILES = /\.(log|tmp|pyc|pyo)$/i;

function isExcluded(rel) {
  if (!rel) return false;
  if (rel.split('/').some((p) => EXCLUDE_DIRS.has(p))) return true;
  return EXCLUDE_FILES.test(rel);
}

function buildLayout() {
  console.log('== building the package layout ==');
  fs.rmSync(LAYOUT, { recursive: true, force: true });
  fs.mkdirSync(LAYOUT, { recursive: true });

  // The Electron runtime and the app resources.
  for (const name of fs.readdirSync(STAGE)) {
    if (name === 'resources') continue; // handled below, with the icons
    copyTree(path.join(STAGE, name), path.join(LAYOUT, name), '');
  }
  copyTree(path.join(STAGE, 'resources'), path.join(LAYOUT, 'resources'), 'resources');

  // The store icons.
  fs.mkdirSync(path.join(LAYOUT, 'assets'), { recursive: true });
  for (const name of fs.readdirSync(ASSETS)) {
    fs.copyFileSync(path.join(ASSETS, name), path.join(LAYOUT, 'assets', name));
  }

  // The installer icon sits at the package root. The NSIS stage already
  // carries the multi-size icon the shortcut uses.
  if (fs.existsSync(ICON)) {
    fs.copyFileSync(ICON, path.join(LAYOUT, 'KnockDesk.ico'));
    console.log('   root icon:', fs.statSync(ICON).size, 'B');
  }

  console.log('   layout files:', countFiles(LAYOUT));
}

function copyTree(src, dest, prefix) {
  const st = fs.statSync(src);
  if (!st.isDirectory()) {
    if (isExcluded(prefix)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return;
  }
  const rel = prefix ? prefix + '/' + path.basename(src) : path.basename(src);
  if (isExcluded(rel)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(s, d, rel);
    else {
      if (isExcluded(rel + '/' + e.name)) continue;
      fs.copyFileSync(s, d);
    }
  }
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
}

// -------------------------------------------------------------- manifest ---
const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
  <Identity Name="KnockDesk.DesktopApp" Publisher="${PUBLISHER}" Version="${VERSION}.0" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>KnockDesk</DisplayName>
    <PublisherDisplayName>OpKnock</PublisherDisplayName>
    <Description>Local-first desktop AI assistant with voice, personas, memory, skills and resident agents.</Description>
    <Logo>assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Applications>
    <Application Id="KnockDesk" Executable="KnockDesk.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
        DisplayName="KnockDesk" Description="Local-first AI assistant" BackgroundColor="transparent"
        Square150x150Logo="assets\\Square150x150Logo.png" Square44x44Logo="assets\\Square44x44Logo.png" />
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities" Name="runFullTrust" />
    <Capability Name="internetClient" />
  </Capabilities>
</Package>
`;

function writeManifest() {
  fs.writeFileSync(path.join(LAYOUT, 'AppxManifest.xml'), MANIFEST);
  console.log('== manifest written ==');
}

// ------------------------------------------------------------------ pack ---
function pack() {
  console.log('== packing ==');
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  fs.rmSync(OUT, { force: true });
  execFileSync(MAKEAPPX, ['pack', '/d', LAYOUT, '/p', OUT, '/o', '/l'],
               { stdio: 'inherit' });
  const size = fs.statSync(OUT).size;
  console.log('   packed:', size.toLocaleString(), 'B');
}

// ------------------------------------------------------------------ sign ---
function sign() {
  if (SKIP_SIGN) {
    console.log('== signing skipped ==');
    return;
  }
  const pfx = process.env.SIGN_PFX;
  const pass = process.env.SIGN_PFX_PASSWORD;
  if (!pfx || !pass) {
    console.log('== signing skipped (set SIGN_PFX and SIGN_PFX_PASSWORD) ==');
    return;
  }
  console.log('== signing ==');
  execFileSync(SIGNTOOL, [
    'sign', '/fd', 'SHA256', '/td', 'SHA256',
    '/tr', process.env.TIMESTAMP_URL || 'http://timestamp.digicert.com',
    '/f', pfx, '/p', pass,
    OUT,
  ], { stdio: 'inherit' });
  console.log('   signed');
}

buildLayout();
writeManifest();
if (!ASSETS_ONLY) {
  pack();
  sign();
}
console.log('DONE');
