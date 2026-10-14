'use strict';
// ── Face Lock — taale ki halat, main process mein ───────────────────────────
//
// User ki marzi ka taala (Settings → Profile). Band ho to ye file kuch nahi
// karti: koi camera, koi model, koi parda — app bilkul waisi jaisi pehle thi.
//
// Chalu ho to:
//   • app khulte hi taala laga hota hai (`locked` yahan hai, page mein nahi —
//     reload, dobara launch ya nayi window se nahi khulta);
//   • Windows lock ho ya PC so jaye to dobara lag jata hai;
//   • khulta sirf `verifyFace` / `verifyPin` ke `ok` par hai.
//
// Chehre ke numbers aur PIN ka hash `face_lock.json` mein, Windows DPAPI se
// band (bilkul `auth.json` ki tarah) — sirf yehi Windows user khol sakta hai.
// Tasveer kabhi save nahi hoti aur kuch bhi PC se bahar nahi jata.
//
// Is taale ki hadd: ye APP ko band karta hai, disk ki files ko nahi. Jis ke
// paas is Windows account ki files tak pohanch hai wo `face_lock.json` mita
// kar taala hata sakta hai — aur yahi support ka "PIN bhool gaya" wala raasta
// bhi hai.

const path = require('path');
const fs = require('fs');
const core = require('./facelock-core');
const defaultStore = require('./key-store');

const FILE_NAME = 'face_lock.json';

class FaceLockManager {
  /**
   * @param {object} opts
   * @param {string} opts.userDataDir
   * @param {object} [opts.store]     key-store jaisa (`readObject`, `writeObject`, `encryptionAvailable`) — test ke liye
   * @param {() => number} [opts.now]
   * @param {string} [opts.platform]
   */
  constructor({ userDataDir, store = defaultStore, now = Date.now, platform = process.platform }) {
    this.filePath = path.join(userDataDir, FILE_NAME);
    this.store = store;
    this.now = now;
    this.platform = platform;
    this.window = null;
    this.listeners = new Set();
    this.ticket = null;

    this.state = this._read();
    // Boot: taala chalu hai to laga hua hai.
    this.locked = Boolean(this.state);
  }

  // ── Bahar ke liye ─────────────────────────────────────────────────────────

  setWindow(win) { this.window = win || null; }
  getWindow() { return this.window; }

  /** `listener({ type: 'locked' | 'unlocked' | 'changed', reason })` */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Sirf Windows, aur sirf jab DPAPI mile — chehre ke numbers plain nahi likhe jate. */
  isSupported() {
    try {
      return this.platform === 'win32' && Boolean(this.store.encryptionAvailable());
    } catch {
      return false;
    }
  }

  isEnabled() { return Boolean(this.state); }
  isLocked() { return this.locked && Boolean(this.state); }

  /** Renderer ko jo dikhta hai. Templates aur PIN ka hash is mein kabhi nahi. */
  status() {
    const now = this.now();
    return {
      supported: this.isSupported(),
      enabled: this.isEnabled(),
      locked: this.isLocked(),
      templateCount: this.state ? this.state.templates.length : 0,
      enrolledAt: this.state ? this.state.createdAt : 0,
      attemptsLeft: core.attemptsLeft(this.state),
      maxAttempts: core.MAX_FREE_ATTEMPTS,
      lockoutMs: this.state ? core.lockoutRemaining(this.state, now) : 0,
      threshold: core.MATCH_THRESHOLD,
      pinLength: core.PIN_LENGTH,
    };
  }

  /**
   * Chehre se pehchan. `purpose: 'unlock'` taala kholta hai; `'manage'`
   * Settings ke liye ek parcha (ticket) deta hai.
   */
  verifyFace({ embeddings, purpose } = {}) {
    const gate = this._gate();
    if (gate) return gate;
    const result = core.matchProbes(embeddings, this.state.templates);
    // Kharab input koshish nahi ginta — wo page ki ghalti hai, insaan ki nahi.
    if (result.reason === 'bad_input') return this._reply({ ok: false, reason: 'bad_input' });
    return this._settle(result.ok, purpose, { score: round3(result.score), reason: result.reason });
  }

  verifyPin({ pin, purpose } = {}) {
    const gate = this._gate();
    if (gate) return gate;
    const ok = core.verifyPin(String(pin ?? ''), this.state.pin);
    return this._settle(ok, purpose, { reason: ok ? 'match' : 'wrong_pin' });
  }

  /**
   * Naya chehra + PIN. Pehli dafa (taala band) seedha; pehle se chalu ho to
   * parcha lazmi — warna khuli app par koi bhi apna chehra daal deta.
   */
  enroll({ templates, pin, ticket } = {}) {
    if (!this.isSupported()) return { ok: false, reason: 'unsupported' };
    if (this.state && !this._useTicket(ticket)) return { ok: false, reason: 'verify_first' };
    const prepared = core.prepareTemplates(templates);
    if (!prepared.ok) return { ok: false, reason: prepared.reason };
    if (!core.isValidPin(pin)) return { ok: false, reason: 'weak_pin' };

    const now = this.now();
    const next = {
      version: 1,
      enabled: true,
      templates: prepared.templates,
      pin: core.hashPin(pin),
      createdAt: now,
      updatedAt: now,
      ...core.CLEAN_ATTEMPTS,
    };
    if (!this._write(next)) return { ok: false, reason: 'save_failed' };
    this.state = core.sanitizeState(next);
    // Abhi abhi maalik ne khud lagaya hai — isi session mein khula rehta hai.
    this.locked = false;
    this._emit('changed', 'enrolled');
    return { ok: true, status: this.status() };
  }

  changePin({ pin, ticket } = {}) {
    if (!this.state) return { ok: false, reason: 'not_enabled' };
    if (!this._useTicket(ticket)) return { ok: false, reason: 'verify_first' };
    if (!core.isValidPin(pin)) return { ok: false, reason: 'weak_pin' };
    const next = { ...this.state, pin: core.hashPin(pin), updatedAt: this.now() };
    if (!this._write(next)) return { ok: false, reason: 'save_failed' };
    this.state = core.sanitizeState(next);
    this._emit('changed', 'pin');
    return { ok: true, status: this.status() };
  }

  disable({ ticket } = {}) {
    if (!this.state) return { ok: true, status: this.status() };
    if (!this._useTicket(ticket)) return { ok: false, reason: 'verify_first' };
    try {
      if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
    } catch {
      return { ok: false, reason: 'save_failed' };
    }
    this.state = null;
    this.locked = false;
    this._emit('changed', 'disabled');
    return { ok: true, status: this.status() };
  }

  /** Taala lagao (agar chalu hai). `true` = ab laga hua hai. */
  lock(reason = 'manual') {
    if (!this.state) return false;
    if (this.locked) return true;
    this.locked = true;
    this.ticket = null;
    this._emit('locked', reason);
    return true;
  }

  /** Windows lock / sleep par dobara taala. */
  attachPowerMonitor(powerMonitor) {
    if (!powerMonitor?.on) return;
    powerMonitor.on('lock-screen', () => this.lock('system-lock'));
    powerMonitor.on('suspend', () => this.lock('system-sleep'));
  }

  // ── Andar ─────────────────────────────────────────────────────────────────

  /** Koshish se pehle ke pehre. Rukawat ho to jawab, warna `null`. */
  _gate() {
    if (!this.state) return { ok: false, reason: 'not_enabled', status: this.status() };
    if (core.lockoutRemaining(this.state, this.now()) > 0) return this._reply({ ok: false, reason: 'lockout' });
    return null;
  }

  _settle(ok, purpose, extra) {
    if (!ok) {
      this._saveAttempts(core.registerFailure(this.state, this.now()));
      return this._reply({ ok: false, ...extra });
    }
    if (this.state.failCount || this.state.lockoutUntil) this._saveAttempts(core.CLEAN_ATTEMPTS);
    if (purpose === 'manage') {
      this.ticket = core.newTicket(this.now());
      return this._reply({ ok: true, ...extra, ticket: this.ticket.value });
    }
    const wasLocked = this.locked;
    this.locked = false;
    if (wasLocked) this._emit('unlocked', 'verified');
    return this._reply({ ok: true, ...extra });
  }

  _reply(body) {
    return { ...body, status: this.status() };
  }

  _useTicket(value) {
    const ticket = this.ticket;
    this.ticket = null; // ek hi dafa
    return Boolean(ticket && typeof value === 'string' && value === ticket.value && ticket.expiresAt > this.now());
  }

  _saveAttempts(attempts) {
    const next = { ...this.state, ...attempts };
    // Likhna nakaam ho to bhi yaad mein ginti rahe — is session mein pehra chalta rahe.
    this._write(next);
    this.state = next;
  }

  _read() {
    try {
      if (!this.isSupported()) return null;
      return core.sanitizeState(this.store.readObject(this.filePath));
    } catch {
      return null;
    }
  }

  _write(next) {
    try {
      this.store.writeObject(this.filePath, next);
      return true;
    } catch (err) {
      console.error('[FaceLock] Could not save state:', err?.message || err);
      return false;
    }
  }

  _emit(type, reason) {
    const event = { type, reason, status: this.status() };
    for (const listener of this.listeners) {
      try { listener(event); } catch (err) { console.error('[FaceLock] listener failed:', err?.message || err); }
    }
    const win = this.window;
    try {
      if (win && !win.isDestroyed()) win.webContents.send('facelock:event', event);
    } catch { /* window ja chuki */ }
  }
}

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

module.exports = { FaceLockManager, FILE_NAME };
