// KnockDesk ka Hermes plugin — install aur update.
//
// ════════════════════════════════════════════════════════════════════════════
//  PLUGIN HERMES KE ANDAR KYUN NAHI RAKHA
// ════════════════════════════════════════════════════════════════════════════
//
//  Hermes ke apne bundled plugins uske install folder mein hote hain
//  (hermes-runtime/…/plugins/platforms/). Wahan apni cheez rakhna do wajah se
//  ghalat hai:
//
//    1. Hermes update hote hi wo folder naye siray se aata hai — hamara
//       plugin chup-chaap ghayab ho jata, aur phone kisi din bina wajah
//       "offline" dikhane lagta.
//    2. Hamara pehla usool hi ye raha hai: Hermes ke source ko haath nahi
//       lagana. Ek dafa us usool se hat gaye to har agli cheez wahan rakhne
//       ka bahana ban jata hai.
//
//  Hermes khud iska jawab deta hai: `~/.hermes/plugins/<naam>/` user ka apna
//  folder hai, jise wo har boot par scan karta hai aur jise koi update nahi
//  chhoo-ta. Yehi hamari jagah hai.
//
// ════════════════════════════════════════════════════════════════════════════
//  VERSION SE FAISLA, WAQT SE NAHI
// ════════════════════════════════════════════════════════════════════════════
//
//  Copy tabhi hoti hai jab plugin.yaml ka `version` alag ho. File ke waqt
//  (mtime) par faisla karna is liye nahi kiya ke installer copy karte waqt
//  waqt badal deta hai — us se har app launch par be-wajah copy hoti rehti
//  aur Hermes ko har baar restart karna parta.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PLUGIN_NAME = 'knockdesk';
// Nayi file yahan likhna BHOOLNA sab se aasaan ghalti hai: plugin chalta
// rehta hai (kyunki `adapter.py` import hone par nayi file na milne par bhi
// `register` apne try/except mein aage barh jata hai), bas naya feature
// chup-chaap gayab rehta hai. Har nayi .py file yahan aani chahiye — aur
// plugin.yaml ka `version` bhi barhana zaroori hai, warna copy hoti hi nahi.
const PLUGIN_FILES = ['plugin.yaml', '__init__.py', 'adapter.py', 'activity.py'];

// Doosra plugin: computer use (`computer_task` tool). Wahi usool, wahi
// installer — sirf naam aur files alag. `marker` wo file hai jis ke hone se
// "install hai" mana jata hai.
const COMPUTER_PLUGIN = {
  name: 'knockdesk-computer',
  files: ['plugin.yaml', '__init__.py', 'tool.py'],
  marker: 'tool.py',
};
const KNOCKDESK_PLUGIN = { name: PLUGIN_NAME, files: PLUGIN_FILES, marker: 'adapter.py' };

// Teesra plugin: Memory Core ka provider. Hermes isi ke zariye wohi yaadash
// parhta/likhta hai jo voice assistant istemal karta hai.
//
// Ye baqi do se ek baat mein alag hai: ye `plugins.enabled` se nahi chalta.
// Hermes mein memory provider "exclusive" qism hai, jo sirf config ke
// `memory.provider: knockdesk-memory` se chuna jata hai (HermesManager ka
// `_ensureMemoryProvider`). Folder ka naam hi provider ka naam hai, is liye
// isay badalna config ki value badalna bhi hai.
const MEMORY_PLUGIN = {
  name: 'knockdesk-memory',
  files: ['plugin.yaml', '__init__.py'],
  marker: '__init__.py',
};

/**
 * Plugin kis folder mein jayega.
 *
 * `hermesHome` BAHAR se aata hai, yahan khud nahi banaya jata — aur ye jaan
 * bujh kar hai. Windows par Hermes ka ghar `%LOCALAPPDATA%\hermes` hai,
 * `~/.hermes` nahi. Wo hisaab HermesManager.getHermesHome() mein ek hi jagah
 * likha hua hai (aur Hermes ke apne hermes_constants.py se mel khata hai).
 * Usay yahan dobara likhne ka matlab do jagah ek hi qanoon rakhna hai — aur
 * do jagah rakha hua qanoon kisi din alag ho jata hai. Us din plugin ek aise
 * folder mein install hota jise Hermes dekhta hi nahi, aur ghalti pakarna
 * bohat mushkil hota.
 */
function pluginTargetDir(hermesHome, name = PLUGIN_NAME) {
  return path.join(hermesHome, 'plugins', name);
}

/**
 * Bundled plugin kahan hai — packaged app mein resources ke andar, dev mein
 * repo ke andar. Dono raaste aazma kar jo mil jaye wahi.
 */
function pluginSourceDir(name = PLUGIN_NAME) {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'hermes-plugins', name) : null,
    // Source-staged app: dist/services -> app root -> resources/hermes-plugins.
    path.resolve(__dirname, '..', '..', 'resources', 'hermes-plugins', name),
    // Source checkout layout (raw services) and compiled Electron dist layout.
    path.resolve(__dirname, '..', '..', '..', '..', 'hermes-plugins', name),
    path.resolve(__dirname, '..', '..', '..', '..', '..', 'hermes-plugins', name),
    path.join(__dirname, '..', '..', 'hermes-plugins', name),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'plugin.yaml'))) return dir;
  }
  return null;
}

/** plugin.yaml se sirf `version:` parhna — poora YAML parser yahan bekar hai. */
function readVersion(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'plugin.yaml'), 'utf8');
    const m = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Installed plugin ka har managed file bundled source se byte-for-byte mel
 * khata hai ya nahi. Waqt (mtime) nahi dekhte — installer copy karte waqt
 * waqt badal deta hai. SHA-256 se pata chalta hai ke code waqai wahi hai jo
 * is app ke saath aaya tha.
 */
function fileDigest(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function managedFilesMatch(source, target, files) {
  return files.every((file) => {
    const expected = fileDigest(path.join(source, file));
    const actual = fileDigest(path.join(target, file));
    return expected !== null && expected === actual;
  });
}

/**
 * Plugin ko user ke Hermes folder mein rakh dena (ya update kar dena).
 *
 * Wapas ek object aata hai:
 *   { ok, changed, version, previous, dir, error }
 *
 * `changed: true` ka matlab hai gateway ko restart karna hoga — Python plugin
 * boot par ek dafa load hota hai, chalte hue nahi badalta.
 *
 * `previous` wo version hai jo copy se PEHLE install tha (`null` = pehli dafa
 * install hua). Memory provider isi se faisla karta hai: pehli install par
 * restart ki zaroorat nahi (kisi process ne purana code load hi nahi kiya),
 * sirf update par hai.
 *
 * Ye function kabhi throw nahi karta. Plugin install na ho paye to Mobile
 * Remote band rahega, magar desktop app ka baqi sara kaam waise hi chalta rahe
 * — ek zaid feature ki nakaami poori app nahi girani chahiye.
 */
function ensureKnockDeskPlugin(hermesHome) {
  return ensurePlugin(hermesHome, KNOCKDESK_PLUGIN);
}

/** Computer-use plugin (`computer_task`) — wahi tareeqa. */
function ensureKnockDeskComputerPlugin(hermesHome) {
  return ensurePlugin(hermesHome, COMPUTER_PLUGIN);
}

/** Memory Core ka provider (`knockdesk-memory`) — wahi tareeqa. */
function ensureKnockDeskMemoryPlugin(hermesHome) {
  return ensurePlugin(hermesHome, MEMORY_PLUGIN);
}

function ensurePlugin(hermesHome, { name, files: PLUGIN_FILES, marker }) {
  if (!hermesHome) {
    return { ok: false, changed: false, error: 'Hermes ka home folder maloom nahi.' };
  }

  const source = pluginSourceDir(name);
  if (!source) {
    return { ok: false, changed: false, error: `Bundled plugin nahi mila: ${name}.` };
  }

  const target = pluginTargetDir(hermesHome, name);
  const wanted = readVersion(source);
  const installed = fs.existsSync(path.join(target, marker)) ? readVersion(target) : null;

  // ── VERSION KAAFI NAHI — FILEIN BHI GIN LO ────────────────────────────────
  //
  // Sirf version dekhna ek asli bug de chuka hai. `activity.py` PLUGIN_FILES
  // mein baad mein shamil hui aur plugin.yaml ka version wahi rehne diya gaya.
  // Nateeja: har us machine par jahan plugin pehle se install tha, version mel
  // kha gaya, copy skip ho gayi, aur wo file KABHI nahi pohnchi. Plugin phir
  // bhi chalta raha (adapter.py usay der se import karta hai) — is liye ghalti
  // kahin nazar nahi aayi, bas ek feature khamoshi se ghayab raha.
  //
  // Ab teen sharton par copy skip hoti hai: version wohi HO, har mutawaqqa
  // file mojood HO, AUR uska content bundled source jaisa HO. Is se na sirf
  // gayab file pakri jati hai, balki woh case bhi jahan code badla ho magar
  // plugin.yaml ka version wohi reh gaya ho.
  const complete = PLUGIN_FILES.every((file) => fs.existsSync(path.join(target, file)));
  const contentsMatch = complete && managedFilesMatch(source, target, PLUGIN_FILES);

  if (installed && wanted && installed === wanted && contentsMatch) {
    return { ok: true, changed: false, version: installed, dir: target };
  }

  if (installed && wanted && installed === wanted && !complete) {
    const missing = PLUGIN_FILES.filter((file) => !fs.existsSync(path.join(target, file)));
    console.warn(
      `[KnockDeskPlugin] ${name} v${installed} adhoora mila (${missing.join(', ')} nahi thi) — dobara copy kar rahe hain.`,
    );
  } else if (installed && wanted && installed === wanted && !contentsMatch) {
    // Version wohi hai magar file ka content badla hua hai. Purane app ne
    // plugin.yaml bump kiye baghair code update kiya ho to bhi naya code
    // users tak pohnch jata hai — warna "fix ship ho gaya" ka matlab sirf
    // source tree tak hota tha, installed plugin par purana code chalta rehta tha.
    console.warn(
      `[KnockDeskPlugin] ${name} v${installed} purana content rakhta hai — bundled files se dobara copy kar rahe hain.`,
    );
  }

  try {
    fs.mkdirSync(target, { recursive: true });

    // ── PURANA __pycache__ HATANA LAZMI HAI ────────────────────────────────
    //
    // Python .py file ke saath uska compiled roop bhi rakhta hai. Naya
    // adapter.py copy karne ke baad agar purana .pyc pada rahe to Python
    // kabhi kabhi usi ko chala deta hai — aur hum ghanton dhoondte rehte hain
    // ke naya code chal kyun nahi raha. Har update par usay saaf kar dena is
    // poori qism ki ghalti khatam kar deta hai.
    const cache = path.join(target, '__pycache__');
    if (fs.existsSync(cache)) fs.rmSync(cache, { recursive: true, force: true });

    for (const file of PLUGIN_FILES) {
      const from = path.join(source, file);
      if (!fs.existsSync(from)) {
        return { ok: false, changed: false, error: `Plugin adhoora hai: ${file} nahi mili.` };
      }
      fs.copyFileSync(from, path.join(target, file));
    }

    console.log(
      `[KnockDeskPlugin] ${name} ${installed ? `${installed} -> ${wanted}` : `v${wanted}`} install ho gaya: ${target}`,
    );
    return { ok: true, changed: true, version: wanted, previous: installed || null, dir: target };
  } catch (err) {
    return { ok: false, changed: false, error: err.message };
  }
}

module.exports = {
  ensureKnockDeskPlugin,
  ensureKnockDeskComputerPlugin,
  ensureKnockDeskMemoryPlugin,
  PLUGIN_NAME,
  COMPUTER_PLUGIN_NAME: COMPUTER_PLUGIN.name,
  MEMORY_PLUGIN_NAME: MEMORY_PLUGIN.name,
  pluginTargetDir,
};
