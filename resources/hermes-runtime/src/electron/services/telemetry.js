// ═══════════════════════════════════════════════════════════════════════════
// telemetry.js — "app khuli" ka ek event. Bas itna hi.
// ---------------------------------------------------------------------------
// KYUN: customer app khareedta hai, access milta hai... aur us ke baad humein
// kuch pata nahi chalta. Kitne log roz app kholte hain? Khareedne ke baad koi
// wapas bhi aata hai? In do sawalon ka jawab dene ke liye ye file hai.
//
// KYA BHEJA JATA HAI:
//   email (account ka), anonymous install id, app version, OS, waqt,
//   session kitni der chali.
//
// KYA KABHI NAHI BHEJA JATA:
//   prompt ka text, awaaz, screen ka content, file ya folder ke naam, chat
//   history — kuch bhi jo user ka apna kaam ho. Is file mein aisi koi cheez
//   parhne wali ek line bhi nahi hai. Naya field add karne se pehle yehi
//   soch lein: ye us list mein to nahi aata?
//
// ── SAB SE AHEM USOOL ──────────────────────────────────────────────────────
// YE FILE APP KO KABHI NAHI TOR SAKTI.
//
// Har export `safe()` ke andar lipta hai — koi exception yahan se bahar nahi
// jata. Koi bhi function kisi cheez ka intezar nahi karwata (na startup, na
// shutdown). Disk full ho, net band ho, server 500 de raha ho, poora
// analytics system delete ho jaye — customer ki app par is ka asar sifar hai.
// Telemetry chup chaap band ho jayegi, app waise hi chalti rahegi.
//
// Agar kabhi is file mein aisi tabdeeli karni pare jo ye zamanat torti ho,
// to wo tabdeeli galat hai.
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

// ── Config ────────────────────────────────────────────────────────────────
const DEFAULT_ENDPOINT = 'http://127.0.0.1:1'; // KnockDesk local build: telemetry backend removed, never leaves this PC.

const SEND_TIMEOUT_MS   = 8000;   // is se lamba intezar karne ka koi faida nahi
const FLUSH_INTERVAL_MS = 10 * 60 * 1000;
const MAX_QUEUE         = 200;    // is se aage purane events girne lagte hain
const MAX_ATTEMPTS      = 10;     // 10 baar na gaya to ye event kabhi nahi jayega
const MAX_BATCH         = 25;     // server ki had 50 hai; hum us se neeche rehte hain

const FILE_QUEUE    = 'telemetry-queue.json';
const FILE_DEVICE   = 'telemetry-device.json';

// ── State ─────────────────────────────────────────────────────────────────
let cfg = null;            // { userDataDir, appVersion, endpoint, machineIdFn }
let deviceId = null;
let flushing = false;
let flushTimer = null;

// Is process ki chalti hui session. `sessionClosed` ka pehra is liye hai ke
// quit ke kai raste hain (window band, Cmd+Q, updater, Windows logoff) aur
// unme se ek se zyada chal sakte hain — warna ek hi session ki lambai do
// baar queue mein chali jati.
let sessionEventId = null;
let sessionStartMs = null;
let sessionClosed  = false;
let openRecorded   = false;

// ── Har cheez ke gird deewar ──────────────────────────────────────────────
// Ye poori file ka bunyadi usool hai: telemetry ka koi masla app tak nahi
// pohnchta. `console.warn` jaan bujh kar — log mein nazar aana chahiye, magar
// caller ko kabhi throw nahi milta.
function safe(label, fn, fallback) {
  try {
    return fn();
  } catch (err) {
    console.warn(`[telemetry] ${label} failed (ignored):`, err?.message || err);
    return fallback;
  }
}

const filePath = (name) => path.join(cfg.userDataDir, name);

function readJson(name, fallback) {
  try {
    const p = filePath(name);
    if (!fs.existsSync(p)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    // File kharab hai. Isay theek karne ki koshish bekaar hai — analytics ka
    // purana data khona koi nuqsan nahi.
    return fallback;
  }
}

function writeJson(name, value) {
  try {
    fs.writeFileSync(filePath(name), JSON.stringify(value), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DEVICE ID
// ---------------------------------------------------------------------------
// Ye sirf EXTRA maloomat hai, identity nahi. Saari ginti aur retention account
// ki EMAIL par hoti hai (app login ke baghair khulti hi nahi, is liye email
// hamesha mojood hoti hai). Ye id sirf ye batane ke liye hai ke ek customer
// kitni alag machines par app chala raha hai.
//
// Do parton wala tareeqa, dono ke apne faide:
//
//   1. File (`telemetry-device.json`) — jab tak install zinda hai, id wahi
//      rehti hai. Hardware badalne (SSD lagwane) se bhi id nahi badalti.
//
//   2. Hardware (`getMachineId` — CPU + disk serial ka SHA-256) — file ka
//      pehla source. App uninstall + reinstall, ya Windows dobara install
//      hone ke baad bhi WAHI id wapas ban jati hai.
//
// Dono milkar dono taraf se cover kar dete hain. Agar hardware bhi na mile to
// aakhri chara ek random id hai — us soorat mein multi-device ki ginti thori
// kam sahi hogi, magar DAU aur retention par koi asar nahi (wo email par hain).
async function resolveDeviceId() {
  const saved = readJson(FILE_DEVICE, null);
  if (saved && typeof saved.id === 'string' && saved.id.length >= 16) {
    return saved.id;
  }

  let id = null;

  if (typeof cfg.machineIdFn === 'function') {
    try {
      const hw = await cfg.machineIdFn();
      if (typeof hw === 'string' && hw.length >= 16) id = hw;
    } catch {
      // Hardware parhna nakaam — neeche random par chale jate hain.
    }
  }

  if (!id) id = crypto.randomBytes(16).toString('hex');

  writeJson(FILE_DEVICE, { id, createdAt: new Date().toISOString() });
  return id;
}

// ── Queue ─────────────────────────────────────────────────────────────────
const readQueue = () => {
  const q = readJson(FILE_QUEUE, []);
  return Array.isArray(q) ? q : [];
};

// Had se zyada bhar jaye to PURANE events girte hain, naye nahi. Wajah: agar
// koi machine mahine bhar offline rahi, to naye din ka sach purane din ke
// sach se zyada kaam ka hai.
function writeQueue(events) {
  const trimmed = events.length > MAX_QUEUE ? events.slice(events.length - MAX_QUEUE) : events;
  return writeJson(FILE_QUEUE, trimmed);
}

function enqueue(event) {
  const q = readQueue();
  q.push(event);
  writeQueue(q);
}

// ── Bhejna ────────────────────────────────────────────────────────────────
// Server hamesha 200 deta hai aur jawab mein `done` bhejta hai — un events ke
// id jinhe queue se hata dena chahiye. Us mein wo bhi hain jo darj ho gaye
// aur wo bhi jo hamesha ke liye rad huay (jaise anjaan email). Jo `done` mein
// nahi, wo waqti masla tha — us par dobara koshish hoti hai.
//
// Ye ahem hai: hum khud faisla nahi karte ke kya dobara bhejna hai. Server
// batata hai. Warna ek permanent rad-shuda event hamesha ke liye queue mein
// atka rehta.
async function sendBatch(batch) {
  const res = await axios.post(
    cfg.endpoint,
    { events: batch.map(({ attempts, ...ev }) => ev) },
    { timeout: SEND_TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } },
  );
  const done = res?.data?.done;
  return Array.isArray(done) ? new Set(done) : new Set();
}

async function flushInternal() {
  if (!cfg || flushing) return;

  let queue = readQueue();
  if (queue.length === 0) return;

  flushing = true;
  try {
    const batch = queue.slice(0, MAX_BATCH);
    let done;

    try {
      done = await sendBatch(batch);
    } catch (err) {
      // Net band, DNS fail, server down, timeout — sab yahan aate hain. Har
      // event ki koshish ginti hai; had par pohnchne wale gir jate hain,
      // taake ek zid'di event queue ko hamesha ke liye jaam na kar de.
      console.warn('[telemetry] flush failed (will retry later):', err?.message || err);

      const batchIds = new Set(batch.map((e) => e.id));
      const after = readQueue()
        .map((e) => (batchIds.has(e.id) ? { ...e, attempts: (e.attempts || 0) + 1 } : e))
        .filter((e) => (e.attempts || 0) < MAX_ATTEMPTS);
      writeQueue(after);
      return;
    }

    // Kamyabi. Queue DOBARA parhi ja rahi hai, apni purani copy nahi likhi ja
    // rahi: network call ke doran `enqueue` chal chuka ho sakta hai, aur apni
    // purani copy likhne se wo naya event chup chaap mit jata.
    const after = readQueue().filter((e) => !done.has(e.id));
    writeQueue(after);

    // Aur bhi parra hai to bhejte raho — magar isi call mein nahi, warna ek
    // bari queue lambi der tak chalti rehti. Agla chakkar isay le lega.
    if (after.length > 0) scheduleFlush(2000);

  } finally {
    flushing = false;
  }
}

function scheduleFlush(delayMs) {
  if (!cfg) return;
  // Timer ko `unref` — ye kabhi app ko band hone se na roke.
  const t = setTimeout(() => { void flushInternal(); }, delayMs);
  if (typeof t.unref === 'function') t.unref();
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ek baar, app ke shuru mein. Sirf config yaad rakhta hai — na network, na
 * disk ka bhaari kaam. Startup ko ek millisecond bhi mehnga nahi karta.
 */
function init({ userDataDir, appVersion, machineIdFn, endpoint } = {}) {
  return safe('init', () => {
    if (!userDataDir) return false;

    cfg = {
      userDataDir,
      appVersion: appVersion || 'unknown',
      endpoint: endpoint || process.env.KNOCKDESK_TELEMETRY_ENDPOINT || process.env.STONIC_TELEMETRY_ENDPOINT || DEFAULT_ENDPOINT,
      machineIdFn,
    };

    return true;
  }, false);
}

/**
 * "App khuli" — login kamyab hone par bulaya jata hai.
 *
 * `await` karne ki zaroorat nahi (aur karni bhi nahi chahiye): ye foran wapas
 * aa jata hai, asal kaam peechay hota hai.
 *
 * Ek process mein sirf ek baar chalta hai. Wajah: AuthGate logout ke baad
 * dobara login par phir se `license-passed` bhejta hai, aur wo ek nayi "app
 * khuli" nahi hai — wohi chalti hui session hai.
 */
function recordOpen(email) {
  return safe('recordOpen', () => {
    if (!cfg || openRecorded) return;
    if (!email || typeof email !== 'string' || !email.includes('@')) return;

    openRecorded = true;

    // Peechay chalne wala kaam. Startup ke raste mein kuch bhi nahi aata —
    // yahan tak ke device id parhna bhi nahi.
    setImmediate(() => {
      void (async () => {
        try {
          if (!deviceId) deviceId = await resolveDeviceId();

          sessionEventId = crypto.randomUUID();
          sessionStartMs = Date.now();
          sessionClosed  = false;

          enqueue({
            id:         sessionEventId,
            type:       'open',
            eventName:  'app_opened',   // aage feature events isi field se aayenge
            email:      email.toLowerCase().trim(),
            deviceId,
            appVersion: cfg.appVersion,
            platform:   process.platform,
            osVersion:  `${os.release()}`,
            openedAt:   new Date().toISOString(),
            attempts:   0,
          });

          // Ek line ka saboot. Is ke baghair "kuch nahi aa raha" ki tehqeeq
          // hamesha andhere mein hoti hai — pata hi nahi chalta ke event bana
          // hi nahi tha ya bana magar pohnch nahi raha. Ab log file (userData/
          // logs) mein ye line ya to hogi ya nahi hogi, aur jawab wahin mil
          // jayega. Email jaan bujh kar nahi likhi — log file share hoti hai.
          console.log('[telemetry] app_opened queued —', cfg.appVersion, process.platform);

          startPeriodicFlush();
          await flushInternal();
        } catch (err) {
          console.warn('[telemetry] recordOpen background step failed (ignored):', err?.message || err);
        }
      })();
    });
  });
}

/**
 * App band ho rahi hai — session ki lambai mehfooz karo.
 *
 * JAAN BUJH KAR SYNCHRONOUS, aur JAAN BUJH KAR yahan se kuch bheja nahi jata.
 *
 * Quit ke waqt network call ka intezar karna do wajah se galat hai: shutdown
 * lataka hua mehsoos hota hai, aur Windows logoff par humein itna waqt milta
 * hi nahi — call adhi mein mar jati aur duration waise bhi kho jati. Is liye
 * hum sirf ek chhoti file likhte hain (microseconds) aur agli launch par wo
 * event chala jata hai.
 *
 * Nateeja: session ki lambai ek launch der se pohnchti hai. DAU, WAU, MAU aur
 * retention par is ka koi asar nahi — wo "app khuli" wale event par hain, jo
 * pehle hi ja chuka hota hai. Yehi wajah hai ke app crash bhi ho jaye to
 * ginti sahi rehti hai; sirf us session ki lambai khaali reh jati hai.
 */
function endSession() {
  return safe('endSession', () => {
    if (!cfg) return;
    if (!sessionEventId || sessionClosed) return;

    sessionClosed = true;

    const seconds = Math.max(0, Math.round((Date.now() - sessionStartMs) / 1000));
    enqueue({
      id:             sessionEventId,
      type:           'close',
      sessionSeconds: seconds,
      attempts:       0,
    });
  });
}

/** Waqfay se queue khaali karna — lambi chalti hui sessions ke liye. */
function startPeriodicFlush() {
  return safe('startPeriodicFlush', () => {
    if (flushTimer || !cfg) return;
    flushTimer = setInterval(() => { void flushInternal(); }, FLUSH_INTERVAL_MS);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  });
}

/** Bahar se hath se flush karwana (test ya "net wapas aa gaya" jaise mauqe par). */
function flush() {
  return safe('flush', () => flushInternal().catch(() => {}), undefined);
}

module.exports = {
  init,
  recordOpen,
  endSession,
  flush,
};
