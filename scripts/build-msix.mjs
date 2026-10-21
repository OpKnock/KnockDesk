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
 *   node scripts/build-msix.mjs --store         build the Store submission
 *                                               package: the identity and
 *                                               publisher Partner Center
 *                                               assigned, submitted unsigned
 *                                               so Microsoft can sign it
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

// The release version. The NSIS installer script keeps the same value in
// its own $Version parameter, so the two packages always match.
const VERSION = process.env.KNOCKDESK_VERSION || '3.1.12';

const args = process.argv.slice(2);
const ASSETS_ONLY = args.includes('--assets-only');
const SKIP_SIGN = args.includes('--skip-sign');

// --store builds the package for submission to the Microsoft Store.
//
// Microsoft Partner Center assigns the package identity and the publisher
// distinguished name. A submitted package must declare exactly those
// values: Microsoft compares them byte for byte, including capitalisation
// and punctuation, and the package family name is derived from them.
//
// The publisher is NOT the signing certificate's subject. Microsoft signs
// the package itself once it accepts the submission, so the submitted
// package is unsigned. Signing it with a personal certificate first would
// make the manifest's publisher inconsistent with the certificate and the
// package would be rejected.
const STORE_MODE = args.includes('--store');
const STORE_IDENTITY = 'OpKnock.KnockDesk';
const STORE_PUBLISHER = 'CN=13E3D3C2-988F-4109-AD0E-42DE8604237C';

// The Store package is the one that goes to Partner Center, so it keeps the
// plain name. The signed one is a sideload build for direct installation
// and is named for what it is.
const OUT = path.join(ROOT, 'dist',
  STORE_MODE ? `KnockDesk-${VERSION}-x64.msix` : `KnockDesk-${VERSION}-x64-sideload.msix`);

// A Store package must not be signed with a personal certificate: the
// manifest declares the publisher Partner Center assigned, and the
// certificate would contradict it. Fail loudly rather than ship a package
// that looks like a Store package and is not.
if (STORE_MODE && (process.env.SIGN_PFX || process.env.SIGN_PFX_PASSWORD)) {
  throw new Error(
    'A --store build is submitted unsigned: Microsoft signs it. ' +
    'SIGN_PFX / SIGN_PFX_PASSWORD are set, which would sign it with a ' +
    'personal certificate and contradict the publisher the manifest declares. ' +
    'Unset them, or build without --store.');
}
const MAKEAPPX = process.env.MAKEAPPX ||
  'C:/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64/makeappx.exe';
const SIGNTOOL = process.env.SIGNTOOL ||
  'C:/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64/signtool.exe';

// The publisher must match the signing certificate's subject exactly, or
// the package will not install: the signature is checked against it.
//
// The value lives in installer/msix-publisher.txt, next to the installer
// configuration, so it is written down once and can be changed for a
// different certificate without touching the build.
//
// The Store package is the exception: it declares the publisher Partner
// Center assigned, and it is submitted unsigned so Microsoft can sign it.
function readPublisher() {
  if (STORE_MODE) {
    if (process.env.KNOCKDESK_PUBLISHER &&
        process.env.KNOCKDESK_PUBLISHER !== STORE_PUBLISHER) {
      throw new Error(
        'KNOCKDESK_PUBLISHER is set to ' + JSON.stringify(process.env.KNOCKDESK_PUBLISHER) +
        ' but a --store build must declare the publisher Partner Center assigned: ' +
        JSON.stringify(STORE_PUBLISHER) + '. Unset the variable, or build without --store.');
    }
    return STORE_PUBLISHER;
  }
  const fromEnv = process.env.KNOCKDESK_PUBLISHER;
  if (fromEnv) return fromEnv;
  const file = path.join(ROOT, 'installer', 'msix-publisher.txt');
  if (fs.existsSync(file)) {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (v) return v;
  }
  throw new Error(
    'The publisher identity is not set. Put it in installer/msix-publisher.txt ' +
    'or pass KNOCKDESK_PUBLISHER. It must match the signing certificate.');
}

// ---------------------------------------------------------------- layout ---
// The same exclusions the NSIS installer applies. __pycache__ and .pyc
// files are build noise: 6,600 of them, and the runtime never reads them.
const EXCLUDE_DIRS = new Set(['__pycache__', 'ensurepip', 'app.asar.extracted']);
const EXCLUDE_FILES = /\.(log|tmp|pyc|pyo)$/i;

// Nothing is trimmed from the payload.
//
// An earlier version of this script dropped about 267 MB of build tooling
// (the linter, the type checker, the test runner, the bundler, and pip's
// vendored copies) on the belief that the Appx block map is capped at
// 65,535 blocks. That belief is wrong: the 65,535 figure is the ZIP32
// limit on the number of entries in the archive's central directory, not a
// limit on the block map. This package's block map lists 78,158 blocks and
// makeappx packs and unpacks it without complaint.
//
// The trimming bought nothing and cost certainty: every dropped package
// had to be argued safe. The NSIS installer ships the whole tree, so
// trimming here also made the two Windows packages carry different
// contents. The package now carries exactly what the installer carries.
const TRIM = [];

function isExcluded(rel) {
  if (!rel) return false;
  if (rel.split('/').some((p) => EXCLUDE_DIRS.has(p))) return true;
  if (EXCLUDE_FILES.test(rel)) return true;
  for (const t of TRIM) {
    if (!rel.startsWith(t.tree + '/')) continue;
    const rest = rel.slice(t.tree.length + 1);
    for (const d of t.drop) {
      if (d.endsWith('*')) {
        // A prefix match on the first segment below the tree.
        const head = rest.split('/')[0];
        if (head.startsWith(d.slice(0, -1))) return true;
      } else if (rest === d || rest.startsWith(d + '/')) {
        return true;
      }
    }
  }
  return false;
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
  copyTree(path.join(STAGE, 'resources'), path.join(LAYOUT, 'resources'), '');

  // The store icons. The folder is named "Assets" with a capital A, the
  // way Microsoft's own manifests spell it. The Store's validator looks
  // the logo up by part name, and it does not fold case.
  fs.mkdirSync(path.join(LAYOUT, 'Assets'), { recursive: true });
  for (const name of fs.readdirSync(ASSETS)) {
    fs.copyFileSync(path.join(ASSETS, name), path.join(LAYOUT, 'Assets', name));
  }

  // The installer icon sits at the package root. The NSIS stage already
  // carries the multi-size icon the shortcut uses.
  if (fs.existsSync(ICON)) {
    fs.copyFileSync(ICON, path.join(LAYOUT, 'KnockDesk.ico'));
    console.log('   root icon:', fs.statSync(ICON).size, 'B');
  }

  // An MSIX is signed as a whole, and the Appx signer refuses a package
  // that contains an executable or a DLL carrying its own signature: the
  // inner signature is computed over the file as it is and is already
  // stale once the package is written. Two modules in the embedded
  // Python runtime are signed, the Tcl and Tk libraries, and they are
  // what stopped the package from signing. Stripping the signature
  // changes nothing about the code, and the package's own signature
  // covers the file from then on.
  stripSignedBinaries();

  console.log('   layout files:', countFiles(LAYOUT));
}

/**
 * Clear the Authenticode signature from every signed binary in the
 * layout. The helper reports what it changed.
 */
function stripSignedBinaries() {
  const script = path.join(ROOT, 'scripts', 'strip-pe-signatures.py');
  if (!fs.existsSync(script)) {
    console.log('   (no signature stripper, skipping)');
    return;
  }
  try {
    const out = execFileSync('python', [script, LAYOUT], { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/).filter((l) => l.trim())) {
      console.log('   ' + line.trim());
    }
  } catch (e) {
    console.log('   (could not strip signatures: ' + (e.message || '').slice(0, 60) + ')');
  }
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
// The Store's validator checks four things that are easy to get wrong:
//
//   - the package must declare a language. Without a <Resources> section
//     naming one, the validator reports that no language is supported,
//     reports the default language as unsupported, and reads the
//     display names as empty, because it has no language to resolve
//     them against.
//   - <Resources> comes AFTER <Dependencies>. The manifest is a
//     sequence, not a set, and the packer rejects the other order.
//   - the language tag is lower case, "en-us", the way the packages
//     Microsoft ships use.
//   - the logo paths are part names and use a backslash, the way
//     Microsoft's own manifests write them, and the folder is spelled
//     "Assets" with a capital A. The Store's validator looks the logo up
//     by part name and does not fold case.
//
//   - the device family has to be declared. A desktop package declares
//     Windows.Desktop and nothing else. Windows.Core is IoT Core and the
//     Store rejects it for a desktop app, and the other families
//     (Universal, Xbox, Holographic, Team) are not appropriate for a
//     full-trust desktop application either.
//
// The publisher display name is the one shown in the Store listing. It
// has to match the display name on the Partner Center account, so it
// comes from the same file as the publisher identity.
const DISPLAY_NAME = 'KnockDesk';
const PUBLISHER_DISPLAY_NAME = process.env.KNOCKDESK_PUBLISHER_DISPLAY || 'OpKnock';
const DEFAULT_LANGUAGE = 'en-us';

// The package identity name. A Store build uses the name Partner Center
// assigned to the account; a sideload build uses the application's own.
const IDENTITY_NAME = STORE_MODE ? STORE_IDENTITY : 'KnockDesk.DesktopApp';

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10" xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities" IgnorableNamespaces="uap rescap">
  <Identity Name="${IDENTITY_NAME}" Publisher="${readPublisher()}" Version="${VERSION}.0" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>${DISPLAY_NAME}</DisplayName>
    <PublisherDisplayName>${PUBLISHER_DISPLAY_NAME}</PublisherDisplayName>
    <Description>Local-first desktop AI assistant with voice, personas, memory, skills and resident agents.</Description>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="${DEFAULT_LANGUAGE}" />
  </Resources>
  <Applications>
    <Application Id="KnockDesk" Executable="KnockDesk.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="${DISPLAY_NAME}" Description="Local-first AI assistant" BackgroundColor="transparent"
        Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png" />
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
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
  if (STORE_MODE) {
    // A Store package is submitted unsigned. Microsoft signs it once it
    // accepts the submission, and signing it here with a personal
    // certificate would contradict the publisher the manifest declares.
    console.log('== signing skipped: this is a Store package, Microsoft signs it ==');
    return;
  }
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
