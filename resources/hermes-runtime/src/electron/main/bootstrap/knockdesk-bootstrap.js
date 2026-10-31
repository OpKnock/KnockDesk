const fs = require('fs');
const path = require('path');
const os = require('os');

// KnockDesk's data home: Documents/KnockDesk Data — FLAT layout (final).
// SOUL.md and MEMORY.md live directly at the root (no .knockdesk/, no memory/
// subfolder). Skills keep their own skills/ subfolder because each skill is
// multi-file (SKILL.md + toggle state) — see main/ipc/skills-handlers.js.
// The legacy ~/.hermes folder belongs to old Hermes installs and is no longer
// read or written for memory. The CURRENT Hermes home on Windows is
// %LOCALAPPDATA%\hermes — KnockDesk must never write into it.
function getKnockDeskBootstrapDir(app) {
  return path.join(app.getPath('documents'), 'KnockDesk Data');
}

function getKnockDeskMemoryDir(app) {
  // Flat layout: memory lives at the root alongside SOUL.md.
  return getKnockDeskBootstrapDir(app);
}

const DEFAULT_SOUL_MD =
  'You are a Loyal Butler — a composed, distinguished male assistant. Formal, respectful, always at service. Speak with precision, quiet confidence, and a touch of class. Use "Sir" where appropriate. Your tone is deep, steady, and reassuring. You are the ultimate personal aide — calm under pressure, never flustered, always one step ahead.';

function ensureKnockDeskDirectories(app) {
  try {
    const notesPath = getKnockDeskBootstrapDir(app);
    if (!fs.existsSync(notesPath)) {
      fs.mkdirSync(notesPath, { recursive: true });
      console.log('Created KnockDesk Data directory:', notesPath);
    }

    // SOUL.md (persona) — one-time copy-forward from the legacy ~/.hermes home
    // so existing users keep their customized persona. Memories are NOT
    // migrated; the store starts fresh at the new location.
    const soulPath = path.join(notesPath, 'SOUL.md');
    if (!fs.existsSync(soulPath)) {
      let soul = DEFAULT_SOUL_MD;
      try {
        const legacySoulPath = path.join(os.homedir(), '.hermes', 'SOUL.md');
        if (fs.existsSync(legacySoulPath)) {
          const legacySoul = fs.readFileSync(legacySoulPath, 'utf8').trim();
          if (legacySoul) soul = legacySoul;
        }
      } catch { /* fall back to the default persona */ }
      fs.writeFileSync(soulPath, soul, 'utf8');
      console.log('[Bootstrap] Created SOUL.md');
    }

    const memoryFilePath = path.join(notesPath, 'MEMORY.md');
    if (!fs.existsSync(memoryFilePath)) {
      fs.writeFileSync(
        memoryFilePath,
        '- [System] KnockDesk Memory System Initialized.',
        'utf8'
      );
      console.log('[Bootstrap] Created default MEMORY.md');
    }

    console.log('[Bootstrap] KnockDesk data directories ready.');
    return notesPath;
  } catch (error) {
    console.error('Failed to create KnockDesk data directories:', error);
    return null;
  }
}

module.exports = {
  ensureKnockDeskDirectories,
  getKnockDeskBootstrapDir,
  getKnockDeskMemoryDir,
};

// Compat: pre-rebrand main.jsc destructures the Stonic names.
module.exports.ensureStonicDirectories = module.exports.ensureKnockDeskDirectories;
module.exports.getStonicBootstrapDir = module.exports.getKnockDeskBootstrapDir;
module.exports.getStonicMemoryDir = module.exports.getKnockDeskMemoryDir;
