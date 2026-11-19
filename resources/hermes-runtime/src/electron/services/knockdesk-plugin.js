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
  // Ab do sharton par copy skip hoti hai: version wohi HO, AUR har mutawaqqa
  // file waqai target par mojood ho. Ye jaanch sasti hai (chand `existsSync`)
  // aur is poori qism ki ghalti hamesha ke liye khatam kar deti hai.
  const complete = PLUGIN_FILES.every((file) => fs.existsSync(path.join(target, file)));

  if (installed && wanted && installed === wanted && complete) {
    return { ok: true, changed: false, version: installed, dir: target };
  }

  if (installed && wanted && installed === wanted && !complete) {
    const missing = PLUGIN_FILES.filter((file) => !fs.existsSync(path.join(target, file)));
    console.warn(
      `[KnockDeskPlugin] ${name} v${installed} adhoora mila (${missing.join(', ')} nahi thi) — dobara copy kar rahe hain.`,
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
  // Purane naam alias ke tor par (koi bahar wala purana naam le to na toote).
  ensureKnockDeskPlugin: ensureKnockDeskPlugin,
  ensureKnockDeskComputerPlugin: ensureKnockDeskComputerPlugin,
  ensureKnockDeskMemoryPlugin: ensureKnockDeskMemoryPlugin,
  PLUGIN_NAME,
  COMPUTER_PLUGIN_NAME: COMPUTER_PLUGIN.name,
  MEMORY_PLUGIN_NAME: MEMORY_PLUGIN.name,
  pluginTargetDir,
};
