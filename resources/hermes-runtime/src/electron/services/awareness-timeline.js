// Awareness ki "diary" — user ne PC par din bhar kya kiya, waqt ke saath.
//
// ════════════════════════════════════════════════════════════════════════════
//  YE FILE ELECTRON KE BAGHAIR HAI — JAAN BUJH KAR
// ════════════════════════════════════════════════════════════════════════════
//
//  Awareness ke do hisse hain: signals pakarna (awareness-manager.js — Electron
//  ka powerMonitor, PowerShell ka watcher) aur un signals ko ek parhne laiq
//  kahani mein badalna (ye file). Doosra hissa sirf data par chalta hai, is
//  liye isay Electron chalaye baghair seconds mein jaancha ja sakta hai
//  (awareness-timeline.test.js).
//
// ── DIARY KI SHAKL ──────────────────────────────────────────────────────────
//
//  Har entry ek lamha hai: { t, kind, ... }
//
//    app    -> ye window saamne aayi          { app, title, private }
//    away   -> user uth gaya (koi input nahi)
//    back   -> wapas aaya                     { mins }
//    lock / unlock / sleep / wake
//    start  -> KnockDesk khula
//
//  Model ko ye kachi list nahi di jati — `digest()` isay chand lines mein
//  samet deta hai ("09:02–10:40 (1h 38m) Code — main.js"), kyunki dimaagh ki
//  har dharkan par ye text bill hota hai.

const MAX_ENTRIES = 600;
const KEEP_MS = 18 * 60 * 60 * 1000;

// Itne se kam der rehne wali window diary mein alag line nahi banti — Alt+Tab
// se guzarte hue har window "kaam" nahi hoti.
const MIN_SEGMENT_MS = 45 * 1000;
// Ek hi app mein title itni jaldi badle (tab palatna, video ka waqt) to nayi
// entry nahi — pichli ka title badal do.
const TITLE_SETTLE_MS = 15 * 1000;
const TITLE_MAX = 110;

// Private browsing aur password managers: title model tak NAHI jata, aur us
// waqt screen bhi nahi dekhi jati (dekho awareness-manager.captureScreen).
const PRIVATE_TITLE = /\b(inprivate|incognito|private browsing|private window)\b/i;
const PRIVATE_APPS = new Set([
  'keepass', 'keepassxc', '1password', 'bitwarden', 'lastpass', 'dashlane', 'nordpass', 'enpass',
]);

/** Window ka naam/title saaf karna, aur private ho to chhupa dena. */
function sanitizeFocus(rawApp, rawTitle) {
  const app = String(rawApp || '').replace(/\.exe$/i, '').trim().slice(0, 60);
  let title = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  const isPrivate = PRIVATE_TITLE.test(title) || PRIVATE_APPS.has(app.toLowerCase());
  if (isPrivate) return { app: app || 'unknown', title: '(private)', private: true };
  if (title.length > TITLE_MAX) title = `${title.slice(0, TITLE_MAX).trimEnd()}…`;
  return { app: app || 'unknown', title, private: false };
}

const pad = (n) => String(n).padStart(2, '0');
const clock = (t) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 95 -> "1h 35m", 7 -> "7m", 0 -> "<1m" */
function humanMinutes(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

class Timeline {
  constructor() {
    this.entries = [];
  }

  /** Disk se bahal karna. Kharab ya purani entries chup-chaap chhoot jati hain. */
  load(list, now = Date.now()) {
    this.entries = (Array.isArray(list) ? list : [])
      .filter((e) => e && Number.isFinite(e.t) && typeof e.kind === 'string' && now - e.t < KEEP_MS && e.t <= now)
      .sort((a, b) => a.t - b.t)
      .slice(-MAX_ENTRIES);
  }

  toJSON() {
    return this.entries;
  }

  /** Waqt ki tarteeb mein daalna — `away` apne asal (pichhle) waqt par likha jata hai. */
  add(entry) {
    if (!entry || !Number.isFinite(entry.t)) return;
    let i = this.entries.length;
    while (i > 0 && this.entries[i - 1].t > entry.t) i -= 1;
    this.entries.splice(i, 0, entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
  }

  /** Saamne wali window badli. `true` = diary mein kuch naya likha gaya. */
  noteFocus(focus, t = Date.now()) {
    const last = this.entries[this.entries.length - 1];
    if (last && last.kind === 'app' && last.app === focus.app) {
      if (last.title === focus.title) return false;
      if (t - last.t < TITLE_SETTLE_MS) {
        last.title = focus.title;
        last.private = focus.private;
        return true;
      }
    }
    this.add({ t, kind: 'app', app: focus.app, title: focus.title, private: focus.private });
    return true;
  }

  prune(now = Date.now()) {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => now - e.t < KEEP_MS);
    return before !== this.entries.length;
  }

  /**
   * Diary ko chand lines mein sametna — model ke parhne ke liye.
   *
   * Ek hi app ki musalsal entries ek line banti hain (us ke do sab se lambe
   * titles ke saath). Chand second wali windows gir jati hain. Lines hadd se
   * zyada hon to purani ek line mein simat jati hain.
   */
  digest(now = Date.now(), { maxLines = 14, sinceMs = 12 * 60 * 60 * 1000 } = {}) {
    const from = now - sinceMs;
    const list = this.entries.filter((e) => e.t >= from);
    const rows = [];
    let seg = null;

    const closeSeg = (endT) => {
      if (!seg) return;
      const dur = Math.max(0, endT - seg.start);
      if (dur >= MIN_SEGMENT_MS) rows.push({ type: 'app', start: seg.start, end: endT, app: seg.app, titles: seg.titles });
      seg = null;
    };

    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.kind === 'app') {
        if (seg && seg.app === e.app) {
          if (e.title) {
            const next = list[i + 1];
            seg.titles.set(e.title, (seg.titles.get(e.title) || 0) + ((next ? next.t : now) - e.t));
          }
          continue;
        }
        closeSeg(e.t);
        const next = list[i + 1];
        seg = { start: e.t, app: e.app, titles: new Map() };
        if (e.title) seg.titles.set(e.title, (next ? next.t : now) - e.t);
        continue;
      }
      closeSeg(e.t);
      rows.push({ type: e.kind, t: e.t, mins: e.mins });
    }
    // Chalti hui window ki line hamesha rehti hai, chahe abhi abhi khuli ho.
    if (seg) rows.push({ type: 'app', start: seg.start, end: now, app: seg.app, titles: seg.titles, current: true });

    const lines = rows.map((r) => {
      if (r.type === 'app') {
        const titles = [...r.titles.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([title]) => `"${title}"`)
          .join('; ');
        const span = r.current ? `${clock(r.start)}–now` : `${clock(r.start)}–${clock(r.end)}`;
        return `${span} (${humanMinutes(r.end - r.start)}) ${r.app}${titles ? ` — ${titles}` : ''}`;
      }
      if (r.type === 'away') return `${clock(r.t)} stepped away from the computer`;
      if (r.type === 'back') return `${clock(r.t)} came back${r.mins ? ` after ${humanMinutes(r.mins * 60000)}` : ''}`;
      if (r.type === 'lock') return `${clock(r.t)} locked the computer`;
      if (r.type === 'unlock') return `${clock(r.t)} unlocked the computer`;
      if (r.type === 'sleep') return `${clock(r.t)} computer went to sleep`;
      if (r.type === 'wake') return `${clock(r.t)} computer woke up${r.mins ? ` after ${humanMinutes(r.mins * 60000)}` : ''}`;
      if (r.type === 'start') return `${clock(r.t)} KnockDesk was opened`;
      return null;
    }).filter(Boolean);

    if (lines.length <= maxLines) return lines;
    const dropped = lines.length - (maxLines - 1);
    return [`(earlier today: ${dropped} more entries, not shown)`, ...lines.slice(dropped)];
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  DINON KA HISAAB — "kal raat 3 baje tak jage the"
// ════════════════════════════════════════════════════════════════════════════
//
//  Diary sirf 18 ghante ki hoti hai, is liye kal ka din us mein nahi milta. Aur
//  jo cheez KnockDesk ko "koi" banati hai wo yehi hai ke usay kal yaad ho. Ledger
//  har din ki chaar baatein rakhta hai: kab shuru, kab khatam, kitni der kaam,
//  aur kin apps mein. Titles nahi — sirf app ke naam.
//
//  Din raat ke 12 par nahi badalta, subah 5 par: jo shakhs raat 3 baje tak
//  kaam kare, us ke liye wo "kal ki raat" hai, "aaj ki subah" nahi.

const DAY_CUT_HOURS = 5;
const LEDGER_KEEP_DAYS = 8;
const LEDGER_MAX_APPS = 16;
// Is se kam kaam wala din zikr ke laiq nahi (app khol kar band kar di).
const LEDGER_MIN_ACTIVE_MS = 5 * 60 * 1000;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Ye lamha kis "din" ka hai — `YYYY-MM-DD`, subah 5 baje se agle 5 baje tak. */
function dayKey(t) {
  const d = new Date(t - DAY_CUT_HOURS * 60 * 60 * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

class DayLedger {
  constructor() {
    this.days = {};
  }

  load(raw, now = Date.now()) {
    this.days = {};
    if (!raw || typeof raw !== 'object') return;
    for (const [key, d] of Object.entries(raw)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !d || typeof d !== 'object') continue;
      if (!Number.isFinite(d.first) || !Number.isFinite(d.last) || !Number.isFinite(d.activeMs) || d.first > now) continue;
      const apps = {};
      for (const [app, ms] of Object.entries(d.apps && typeof d.apps === 'object' ? d.apps : {})) {
        if (Number.isFinite(ms) && ms > 0) apps[String(app).slice(0, 60)] = ms;
      }
      this.days[key] = { first: d.first, last: Math.min(d.last, now), activeMs: Math.max(0, d.activeMs), apps };
    }
    this.prune();
  }

  toJSON() {
    return this.days;
  }

  /** User `deltaMs` se saamne tha (lamha `t` par khatam), is app mein. */
  note(t, app, deltaMs) {
    if (!Number.isFinite(t) || !(deltaMs > 0)) return;
    const key = dayKey(t);
    let d = this.days[key];
    if (!d) {
      d = this.days[key] = { first: t - deltaMs, last: t, activeMs: 0, apps: {} };
      this.prune();
    }
    d.last = Math.max(d.last, t);
    d.activeMs += deltaMs;
    if (app) {
      d.apps[app] = (d.apps[app] || 0) + deltaMs;
      const names = Object.keys(d.apps);
      if (names.length > LEDGER_MAX_APPS) {
        names.sort((a, b) => d.apps[a] - d.apps[b]);
        delete d.apps[names[0]];
      }
    }
  }

  prune() {
    const keys = Object.keys(this.days).sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - LEDGER_KEEP_DAYS))) delete this.days[key];
  }

  /** Aaj ab tak: kitni der kaam, aur din kab shuru hua. */
  today(now = Date.now()) {
    const d = this.days[dayKey(now)];
    if (!d) return null;
    return { activeMinutes: Math.round(d.activeMs / 60000), firstSeenAt: d.first };
  }

  /** Pichhle din, taaza pehle — model ke parhne ke liye. Aaj shamil nahi. */
  lines(now = Date.now(), { max = 3 } = {}) {
    const todayKey = dayKey(now);
    const yesterdayKey = dayKey(now - 24 * 60 * 60 * 1000);
    return Object.keys(this.days)
      .filter((key) => key < todayKey && this.days[key].activeMs >= LEDGER_MIN_ACTIVE_MS)
      .sort()
      .reverse()
      .slice(0, max)
      .map((key) => {
        const d = this.days[key];
        const [y, m, day] = key.split('-').map(Number);
        const date = new Date(y, m - 1, day, 12);
        const label = key === yesterdayKey
          ? `Yesterday (${WEEKDAYS[date.getDay()]})`
          : `${WEEKDAYS[date.getDay()]} ${day} ${MONTHS[m - 1]}`;
        const apps = Object.keys(d.apps).sort((a, b) => d.apps[b] - d.apps[a]).slice(0, 3);
        return `${label}: at the computer ${clock(d.first)}–${clock(d.last)}, about ${humanMinutes(d.activeMs)} of it active${apps.length ? ` — mostly ${apps.join(', ')}` : ''}.`;
      });
  }
}

module.exports = {
  Timeline, DayLedger, dayKey, sanitizeFocus, humanMinutes,
  MIN_SEGMENT_MS, TITLE_SETTLE_MS, KEEP_MS, DAY_CUT_HOURS,
};
