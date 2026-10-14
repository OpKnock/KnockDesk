const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

// Every skill in KnockDesk is user-authored, and they all live in ONE folder.
//
// That path is load-bearing: skills written by earlier versions of the app are
// already sitting there on real installs, so it must never move. Hermes is
// pointed at the very same directory through `skills.external_dirs` (see
// HermesManager._ensureSkillsExternalDir) — which is what lets a single skill
// serve the voice assistant AND the agents without ever being copied. Move this
// path and both halves break at once.
function getCustomSkillsDir() {
  const dir = path.join(app.getPath('documents'), 'KnockDesk Data', 'skills', 'custom');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Toggle state for loose `.md` skills — ones hand-dropped into the folder
// rather than created by the UI. Folder skills keep theirs beside SKILL.md.
// The `core-` filename prefix is legacy: these files were written under that
// name by earlier builds, and renaming them would silently re-enable skills
// the user had switched off.
const getStatesDir = () => {
  const dir = path.join(getCustomSkillsDir(), '..', '.states');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const statePathFor = (folderName) => (
  folderName.endsWith('.md')
    ? path.join(getStatesDir(), `core-${folderName.slice(0, -3)}.json`)
    : path.join(getCustomSkillsDir(), folderName, '.state.json')
);

const readEnabled = (folderName) => {
  const statePath = statePathFor(folderName);
  if (!fs.existsSync(statePath)) return true;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8')).enabled !== false;
  } catch (_error) {
    return true;
  }
};

function registerSkillsHandlers({ getHermesManager } = {}) {
  const parseSkillMd = (content, filePath) => {
    const cleaned = content.replace(/^\uFEFF/, '');
    const normalized = cleaned.replace(/\r\n/g, '\n');
    const frontmatterMatch = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
    if (!frontmatterMatch) return null;

    const yamlBlock = frontmatterMatch[1];
    const body = normalized.slice(frontmatterMatch[0].length).trim();
    const meta = {};

    for (const line of yamlBlock.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();

      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map((item) => item.trim().replace(/['"]/g, ''));
      }
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (
        typeof value === 'string'
        && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      meta[key] = value;
    }

    return { ...meta, body, filePath };
  };

  const toSkill = (parsed, folderName, filePath) => ({
    name: parsed.name,
    description: parsed.description || '',
    author: parsed.author || 'User',
    version: parsed.version || '1.0.0',
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    enabled: readEnabled(folderName),
    folderName,
    filePath,
  });

  const loadSkills = () => {
    const dir = getCustomSkillsDir();
    const skills = [];

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      return skills;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;

      // Loose `.md` file — kept working for anyone who dropped one in by hand.
      // Hermes only indexes SKILL.md inside a folder, so these stay voice-only.
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const skillPath = path.join(dir, entry.name);
        try {
          const parsed = parseSkillMd(fs.readFileSync(skillPath, 'utf8'), skillPath);
          if (parsed && parsed.name) skills.push(toSkill(parsed, entry.name, skillPath));
        } catch (error) {
          console.error(`[Skills] Error reading loose skill ${entry.name}:`, error.message);
        }
        continue;
      }

      if (!entry.isDirectory()) continue;

      const skillPath = path.join(dir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;

      try {
        const parsed = parseSkillMd(fs.readFileSync(skillPath, 'utf8'), skillPath);
        if (parsed && parsed.name) skills.push(toSkill(parsed, entry.name, skillPath));
      } catch (error) {
        console.error(`[Skills] Error reading skill ${entry.name}:`, error.message);
      }
    }

    return skills;
  };

  // Mirror the UI's on/off switch into Hermes' own `skills.disabled` list.
  // Without this a skill the user switched off here would keep showing up in
  // every agent's system prompt — the two sides read the same folder, so they
  // have to agree on which entries in it are live.
  //
  // Best-effort by design: Hermes may not be running yet, and a skill that
  // stays enabled agent-side is a far smaller problem than a blocked toggle.
  const syncDisabledToHermes = async (skillName, enabled) => {
    const mgr = getHermesManager && getHermesManager();
    if (!mgr || typeof mgr.setSkillDisabled !== 'function') return;
    try {
      await mgr.setSkillDisabled(skillName, !enabled);
    } catch (error) {
      console.warn('[Skills] Could not sync toggle to Hermes:', error.message);
    }
  };

  ipcMain.handle('skills-get-all', async () => {
    try {
      return { success: true, skills: loadSkills() };
    } catch (error) {
      return { error: `Failed to load skills: ${error.message}` };
    }
  });

  ipcMain.handle('skills-load-content', async (_event, { skillName }) => {
    try {
      const skillMeta = loadSkills().find(
        (skill) => skill.name === skillName || skill.folderName === skillName,
      );
      if (!skillMeta) return { error: `Skill "${skillName}" not found` };

      const content = fs.readFileSync(skillMeta.filePath, 'utf8');
      const parsed = parseSkillMd(content, skillMeta.filePath);
      if (parsed) return { success: true, content: parsed.body, metadata: parsed };

      return { error: `Failed to parse skill "${skillName}"` };
    } catch (error) {
      return { error: `Failed to load skill: ${error.message}` };
    }
  });

  ipcMain.handle('skills-save', async (_event, { name, description, author, version, tags, content, folderName }) => {
    try {
      const customSkillsDir = getCustomSkillsDir();
      let safeFolderName = folderName || name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
      safeFolderName = safeFolderName.replace('.md', '');

      const skillDir = path.join(customSkillsDir, safeFolderName);
      if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });

      const tagsStr = Array.isArray(tags) ? `[${tags.join(', ')}]` : (tags || '[]');
      const frontmatter = [
        '---',
        `name: ${name}`,
        `description: ${description || ''}`,
        `author: ${author || 'User'}`,
        `version: ${version || '1.0.0'}`,
        `tags: ${tagsStr}`,
        '---',
      ].join('\n');

      const fullContent = `${frontmatter}\n\n${content || `# ${name}\n\nAdd your skill instructions here.`}`;
      const skillPath = path.join(skillDir, 'SKILL.md');
      fs.writeFileSync(skillPath, fullContent, 'utf8');

      return { success: true, filePath: skillPath, folderName: safeFolderName };
    } catch (error) {
      return { error: `Failed to save skill: ${error.message}` };
    }
  });

  ipcMain.handle('skills-delete', async (_event, { folderName }) => {
    try {
      const skillDir = path.join(getCustomSkillsDir(), folderName);
      if (!fs.existsSync(skillDir)) return { error: 'Skill folder not found' };

      fs.rmSync(skillDir, { recursive: true, force: true });
      return { success: true };
    } catch (error) {
      return { error: `Failed to delete skill: ${error.message}` };
    }
  });

  ipcMain.handle('skills-toggle', async (_event, { folderName, enabled }) => {
    try {
      const statePath = statePathFor(folderName);
      if (!folderName.endsWith('.md') && !fs.existsSync(path.dirname(statePath))) {
        return { error: 'Skill not found' };
      }

      fs.writeFileSync(statePath, JSON.stringify({ enabled }), 'utf8');

      const skill = loadSkills().find((entry) => entry.folderName === folderName);
      if (skill) await syncDisabledToHermes(skill.name, enabled);

      return { success: true };
    } catch (error) {
      return { error: `Failed to toggle skill: ${error.message}` };
    }
  });
}

module.exports = { registerSkillsHandlers, getCustomSkillsDir };
