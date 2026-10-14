'use strict';
// ── Provider API keys — Lifetime (Custom API) ki keys disk par ──────────────
//
// Lifetime customer apni Gemini / OpenAI / OpenRouter / Groq keys app mein
// daalta hai. Ye un ka paisa hai: key chori ho jaye to bill UN ke naam par
// banta hai. Is liye disk par ye ab bilkul `auth.json` ki tarah rakhi jati
// hain — Windows DPAPI (Electron safeStorage) se encrypted:
//
//     { "enc": "knockdesk-dpapi-v1", "data": "<base64 DPAPI blob>" }
//
// Sirf YEHI Windows user isay khol sakta hai. Gen 2 ki purani plain-text file
// pehli parhai par khud encrypted ho jati hai — koi key dobara nahi daalni
// parti.
//
// Do usool:
//   1. Parhne wala kabhi nahi girta — kharab/na-khulne wali file "koi key
//      nahi" hai, crash nahi.
//   2. `saved` aur `value` alag hain: khali string ka matlab "user ne khana
//      khali kar ke Save dabaya" — us soorat mein environment variable wali
//      fallback NAHI chalti, warna mitai hui key wapas zinda ho jati.
//
// Encryption na mile (Windows ke ilawa, ya DPAPI band) to file plain rehti
// hai — bilkul Gen 2 jaisi. Key ke baghair app chalana is se bura hai.

const fs = require('fs');

const ENC_MARK = 'knockdesk-dpapi-v1';

let safeStorage = null;
try {
  // Test (seedha Node) mein electron nahi hota — tab plain.
  ({ safeStorage } = require('electron'));
} catch {
  safeStorage = null;
}

function encryptionAvailable() {
  try {
    return process.platform === 'win32' && Boolean(safeStorage?.isEncryptionAvailable?.());
  } catch {
    return false;
  }
}

/** Poori file ka object — decrypt kar ke. Na mile / na khule to `null`. */
function readObject(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.enc === ENC_MARK && typeof parsed.data === 'string') {
      if (!encryptionAvailable()) return null;
      return JSON.parse(safeStorage.decryptString(Buffer.from(parsed.data, 'base64')));
    }
    // Purani (Gen 2) plain file — ek dafa encrypted likh do.
    if (encryptionAvailable()) {
      try { writeObject(filePath, parsed); } catch { /* agli dafa phir koshish */ }
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeObject(filePath, data) {
  const json = JSON.stringify(data, null, 2);
  if (encryptionAvailable()) {
    const blob = safeStorage.encryptString(json).toString('base64');
    fs.writeFileSync(filePath, JSON.stringify({ enc: ENC_MARK, data: blob }));
  } else {
    fs.writeFileSync(filePath, json);
  }
}

/**
 * `{ saved, value }` — `fields` mein se pehla jo file mein mojood ho.
 * `saved: true` + `value: null` = user ne jaan bujh kar khali kiya.
 */
function readKey(filePath, fields) {
  const data = readObject(filePath);
  if (!data) return { saved: false, value: null };
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) continue;
    const value = data[field];
    return { saved: true, value: typeof value === 'string' && value.trim() ? value.trim() : null };
  }
  return { saved: false, value: null };
}

/** Kuch fields likho, baqi file waisi rahe (jaise primary + backup Gemini key). */
function writeKeys(filePath, fields) {
  const current = readObject(filePath) || {};
  const next = { ...current, updatedAt: Date.now() };
  for (const [k, v] of Object.entries(fields)) next[k] = String(v ?? '').trim();
  writeObject(filePath, next);
  return true;
}

module.exports = { readKey, writeKeys, readObject, writeObject, encryptionAvailable, ENC_MARK };
