'use strict';
// ── Face Lock ka hisaab — electron ke baghair, taake seedha Node mein parkha
//    ja sake (facelock-core.test.js) ────────────────────────────────────────
//
// Chehre ki pehchan ke teen hisse hain aur sirf AAKHRI yahan hai:
//
//   1. Chehra dhoondna + zinda hone ka saboot (palak)  → renderer, camera ke paas
//   2. Chehre ko 128 numbers mein badalna (SFace model) → renderer
//   3. Un numbers ko save kiye hue numbers se milana    → YAHAN, main process
//
// Teesra hissa main process mein is liye hai ke "khol do" ka faisla wahan ho
// jahan page ka JS nahi pohnchta. Renderer sirf numbers bhejta hai; save kiye
// hue numbers (templates) kabhi wapas renderer ko nahi jate, aur taala sirf
// yahan ke `ok: true` par khulta hai.
//
// Hadd ka sach: aam webcam mein gehrai ka sensor nahi, is liye ye ghar/office
// ke logon ke liye taala hai, bank wala nahi. Numbers neeche isi soch se chune
// gaye hain — sakht itne ke doosra chehra na khole, naram itne ke maalik ko
// kharab roshni mein PIN par na jana pare.

const crypto = require('crypto');

const EMBEDDING_DIM = 128;

// Enrollment: 1 seedha + sar ghumane wale zaawiye.
const MIN_TEMPLATES = 3;
const MAX_TEMPLATES = 12;

// Ek koshish = palak se pehle aur baad ke chand frames.
const MIN_PROBES = 3;
const MAX_PROBES = 8;

// Cosine similarity ki had. SFace ke banane walon ki "sab se sahi" had 0.363
// hai (wahan ghalat-qabool aur ghalat-inkaar barabar hote hain). Taale ke liye
// ghalat-qabool zyada mehnga hai, is liye had upar rakhi gayi.
const MATCH_THRESHOLD = 0.5;

// Ek hi koshish ke frames aapas mein bhi milne chahiye — warna palak kisi aur
// ne jhapki aur chehra kisi aur ka dikhaya gaya.
const PROBE_COHERENCE_MIN = 0.45;

// Enrollment ke templates ek hi insaan ke hon (zaawiye ki wajah se thora farq
// jaiz hai, is liye ye had naram hai).
const TEMPLATE_COHERENCE_MIN = 0.3;

const PIN_LENGTH = 6;
const WEAK_PINS = new Set(['123456', '654321', '123123', '112233', '121212']);

// 5 muft koshishein, phir har nakaami par barhta hua intezaar.
const MAX_FREE_ATTEMPTS = 5;
const LOCKOUT_STEPS_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000];

// Settings mein "band karo / dobara scan / PIN badlo" se pehle pehchan — us ka
// parcha itni der chalta hai.
const TICKET_TTL_MS = 2 * 60_000;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

// ── Vectors ─────────────────────────────────────────────────────────────────

/** 128 numbers → unit length. Kuch bhi ghalat ho to `null`. */
function normalizeEmbedding(raw) {
  if (!raw || typeof raw.length !== 'number' || raw.length !== EMBEDDING_DIM) return null;
  const out = new Array(EMBEDDING_DIM);
  let sum = 0;
  for (let i = 0; i < EMBEDDING_DIM; i += 1) {
    const v = Number(raw[i]);
    if (!Number.isFinite(v)) return null;
    out[i] = v;
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  if (!(norm > 1e-6)) return null;
  for (let i = 0; i < EMBEDDING_DIM; i += 1) out[i] /= norm;
  return out;
}

function normalizeList(raw, min, max) {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) return null;
  const out = [];
  for (const item of raw) {
    const vec = normalizeEmbedding(item);
    if (!vec) return null;
    out.push(vec);
  }
  return out;
}

/** Dono pehle se unit length hain, is liye sirf dot product. */
function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < EMBEDDING_DIM; i += 1) dot += a[i] * b[i];
  return dot;
}

function median(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function minPairwise(vectors) {
  let min = 1;
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      min = Math.min(min, cosine(vectors[i], vectors[j]));
    }
  }
  return min;
}

/**
 * Ek koshish ka faisla.
 *
 * Har frame ka score = us ka sab se qareebi template. Koshish ka score = in
 * ka median — ek acha ya ek bura frame akela faisla nahi badal sakta.
 */
function matchProbes(rawProbes, templates, threshold = MATCH_THRESHOLD) {
  const probes = normalizeList(rawProbes, MIN_PROBES, MAX_PROBES);
  if (!probes) return { ok: false, score: 0, reason: 'bad_input' };
  if (!Array.isArray(templates) || templates.length === 0) return { ok: false, score: 0, reason: 'not_enrolled' };

  const perProbe = probes.map((probe) => {
    let best = -1;
    for (const template of templates) best = Math.max(best, cosine(probe, template));
    return best;
  });
  const score = median(perProbe);

  if (minPairwise(probes) < PROBE_COHERENCE_MIN) return { ok: false, score, reason: 'incoherent' };
  if (score < threshold) return { ok: false, score, reason: 'no_match' };
  return { ok: true, score, reason: 'match' };
}

/** Enrollment ke templates: sahi shakal, sahi ginti, aur ek hi insaan. */
function prepareTemplates(raw) {
  const templates = normalizeList(raw, MIN_TEMPLATES, MAX_TEMPLATES);
  if (!templates) return { ok: false, reason: 'bad_input' };
  // Pehla template seedhe chehre ka hai — baqi sab usi se naape jate hain.
  for (let i = 1; i < templates.length; i += 1) {
    if (cosine(templates[0], templates[i]) < TEMPLATE_COHERENCE_MIN) return { ok: false, reason: 'incoherent' };
  }
  // Disk par 6 hindse kaafi hain (float32 ki durusti se zyada).
  return { ok: true, templates: templates.map((t) => t.map((v) => Math.round(v * 1e6) / 1e6)) };
}

// ── PIN ─────────────────────────────────────────────────────────────────────

function isValidPin(pin) {
  if (typeof pin !== 'string' || !new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) return false;
  if (/^(\d)\1+$/.test(pin)) return false; // 000000, 111111 …
  return !WEAK_PINS.has(pin);
}

function hashPin(pin, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function verifyPin(pin, record) {
  if (!record || typeof record.salt !== 'string' || typeof record.hash !== 'string') return false;
  if (typeof pin !== 'string' || pin.length !== PIN_LENGTH) return false;
  try {
    const expected = Buffer.from(record.hash, 'hex');
    const actual = Buffer.from(hashPin(pin, record.salt).hash, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ── Nakaam koshishein ───────────────────────────────────────────────────────

/** Abhi kitni der ka intezaar baqi hai (ms). 0 = koshish ki ja sakti hai. */
function lockoutRemaining(state, now) {
  const until = Number(state?.lockoutUntil) || 0;
  if (until <= now) return 0;
  // Ghari peeche ki gayi ho to intezaar sab se lambe qadam se zyada na ho.
  return Math.min(until - now, LOCKOUT_STEPS_MS[LOCKOUT_STEPS_MS.length - 1]);
}

function attemptsLeft(state) {
  return Math.max(0, MAX_FREE_ATTEMPTS - (Number(state?.failCount) || 0));
}

/** Nakaami darj karo. Nayi `{ failCount, lockoutUntil }` wapas. */
function registerFailure(state, now) {
  const failCount = (Number(state?.failCount) || 0) + 1;
  let lockoutUntil = 0;
  if (failCount >= MAX_FREE_ATTEMPTS) {
    const step = Math.min(failCount - MAX_FREE_ATTEMPTS, LOCKOUT_STEPS_MS.length - 1);
    lockoutUntil = now + LOCKOUT_STEPS_MS[step];
  }
  return { failCount, lockoutUntil };
}

const CLEAN_ATTEMPTS = Object.freeze({ failCount: 0, lockoutUntil: 0 });

// ── Disk par halat ──────────────────────────────────────────────────────────

/**
 * File se aayi cheez ko saaf karo. Jo bhi adhoora ya kharab ho → `null`, yani
 * "taala laga hi nahi". Jaan bujh kar: adhoori file par taala lagana maalik ko
 * apni hi app se bahar kar deta, aur file mitana waise bhi taala hata deta hai.
 */
function sanitizeState(raw) {
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return null;
  const templates = normalizeList(raw.templates, MIN_TEMPLATES, MAX_TEMPLATES);
  if (!templates) return null;
  if (!raw.pin || typeof raw.pin.salt !== 'string' || typeof raw.pin.hash !== 'string') return null;
  return {
    version: 1,
    enabled: true,
    templates,
    pin: { salt: raw.pin.salt, hash: raw.pin.hash },
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
    failCount: Math.max(0, Math.floor(Number(raw.failCount) || 0)),
    lockoutUntil: Math.max(0, Number(raw.lockoutUntil) || 0),
  };
}

function newTicket(now) {
  return { value: crypto.randomBytes(24).toString('hex'), expiresAt: now + TICKET_TTL_MS };
}

module.exports = {
  EMBEDDING_DIM,
  MIN_TEMPLATES,
  MAX_TEMPLATES,
  MIN_PROBES,
  MAX_PROBES,
  MATCH_THRESHOLD,
  PROBE_COHERENCE_MIN,
  TEMPLATE_COHERENCE_MIN,
  PIN_LENGTH,
  MAX_FREE_ATTEMPTS,
  LOCKOUT_STEPS_MS,
  TICKET_TTL_MS,
  CLEAN_ATTEMPTS,
  normalizeEmbedding,
  cosine,
  matchProbes,
  prepareTemplates,
  isValidPin,
  hashPin,
  verifyPin,
  lockoutRemaining,
  attemptsLeft,
  registerFailure,
  sanitizeState,
  newTicket,
};
