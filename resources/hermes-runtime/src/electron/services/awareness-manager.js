// Awareness ki "aankhein" — KnockDesk ko pata ho ke PC par kya ho raha hai.
//
// ════════════════════════════════════════════════════════════════════════════
//  YE KYA HAI
// ════════════════════════════════════════════════════════════════════════════
//
//  KnockDesk ka "khud bolna" (Proactive Presence) teen hisson mein hai:
//
//    aankhein  -> ye file. Signals pakarti hai aur diary likhti hai. Koi model
//                 nahi, koi network nahi — sab kuch isi machine par, muft.
//    dimaagh   -> renderer (src/lib/awareness). Diary le kar model se poochta
//                 hai: chup rahun ya kuch kahun?
//    awaaz     -> maujooda voice session (useGeminiLive).
//
//  Dimaagh renderer mein is liye hai ke login session, character aur voice
//  wahin hain. Aankhein yahan is liye ke `powerMonitor` aur screen capture
//  sirf main process ke paas hain.
//
// ── SIGNALS, AUR UN KA KHARCHA ──────────────────────────────────────────────
//
//    idle / lock / sleep / battery -> Electron ka powerMonitor. Muft.
//    saamne wali window, mic,      -> Windows par EK hamesha-chalta PowerShell
//    screen jagi hui hai ya nahi      (awareness-focus-watch.js — loop compiled
//                                     C# mein, sirf tabdeeli par likhta hai).
//                                     macOS par AppleScript, har 8 s.
//    screen ki tasveer             -> sirf jab dimaagh maange. Kabhi khud nahi.
//
//  Watcher na chal sake (antivirus, band PowerShell) to awareness RUKTI NAHI —
//  sirf window ka naam nahi hota; waqt, idle aur lock phir bhi chalte hain.
//
// ── "VIDEO DEKH RAHA HAI" ≠ "UTH GAYA" ──────────────────────────────────────
//
//  Mouse/keyboard na hile to Windows usay idle ginta hai — chahe user saamne
//  baitha film dekh raha ho. Pehle ye "uth gaya" ban jata tha, aur mouse hilate
//  hi KnockDesk "wapas aa gaye?" poochta, jab ke wo gaya hi nahi tha. Ab watcher
//  batata hai ke koi app screen ko jagaye hue hai (video, presentation): tab
//  tak user "dekh raha hai" — na uth gaya, na usay tokna hai.
//
// ── SIRF JAB SETTING ON HO ──────────────────────────────────────────────────
//
//  `configure({ enabled: false })` par kuch nahi chalta: na watcher, na poll,
//  na diary. Default band hai. Band rahe to purani diary bhi disk se hat jati hai.

const { app, BrowserWindow, powerMonitor, desktopCapturer, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Timeline, DayLedger, sanitizeFocus, KEEP_MS } = require('./awareness-timeline');
const { FOCUS_WATCH_PS1 } = require('./awareness-focus-watch');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

const POLL_MS = 5 * 1000;
// Renderer ki ghari. Chhupi hui window ke timers Chromium sust kar deta hai
// (minute mein ek dafa tak), magar IPC ka paighaam foran pohnchta hai — is liye
// dimaagh ki dharkan yahan se chalti hai.
const TICK_MS = 10 * 1000;
// Itni der koi input nahi = user uth gaya.
const AWAY_AFTER_S = 180;
// Input nahi magar screen par kuch chal raha hai: itni der baad "dekh raha hai".
const WATCH_AFTER_S = 120;
// Itni der tak bina input ke bhi "dekh raha hai" — ek lambi film. Is ke baad
// maan lete hain ke so gaya ya chala gaya (YouTube autoplay raat bhar chalta hai).
const WATCH_MAX_IDLE_S = 3 * 60 * 60;
// Wapsi par: idle ke dauran itne hisse mein screen jagi rahi ho to wo "dekh raha tha".
const WATCHED_SHARE = 0.6;
// Is se lambi ghair-hazri ke baad "lagataar kaam" ki ginti sifar se.
const LONG_AWAY_MS = 5 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 30 * 1000;
// Dinon ka hisaab har poll par badalta hai; disk par itne waqfe se.
const LEDGER_SAVE_MS = 2 * 60 * 1000;
const FOCUS_INTERVAL_MS = 2000;
// Call/meeting pehchanne ke liye: Windows batata hai kaun si app is lamhe mic
// istemal kar rahi hai (awareness-focus-watch.js). Sirf ye apps "call" ginti hain
// — messengers, meeting apps aur browsers (Meet, Zoom web, WhatsApp web).
// Har mic wali app nahi: OBS se recording ya dictation ke dauran KnockDesk ka chup
// ho jana ghalat hota (aur demo video banana na-mumkin).
const CALL_APPS = /zoom|teams|webex|skype|slack|discord|whatsapp|telegram|signal|viber|facetime|chrome|msedge|firefox|brave|opera|vivaldi|comet/i;
const MAC_FOCUS_INTERVAL_MS = 8000;
const WATCHER_MAX_RESTARTS = 4;
const SCREENSHOT_MAX = { width: 1280, height: 800 };
const LOG_MAX_BYTES = 1024 * 1024;
// KnockDesk ki apni window ka naam — model aur dinon ke hisaab, dono ke liye.
const OWN_APP_NAME = 'KnockDesk (this app)';

class AwarenessManager {
  constructor({ userDataDir } = {}) {
    this.mainWindow = null;
    this.running = false;
    this.dir = path.join(userDataDir || app.getPath('userData'), 'awareness');
    this.diaryPath = path.join(this.dir, 'diary.json');
    this.timeline = new Timeline();
    this.ledger = new DayLedger();
    this._bootAt = Date.now();
    this._startLogged = false;
    this._activeSince = Date.now();
    this._away = false;
    this._awaySince = 0;
    this._locked = false;
    this._suspendedAt = 0;
    this._focus = null;              // { app, title, private, own, since }
    this._micInCallBy = null;        // call wali app jo abhi mic istemal kar rahi hai
    this._screenAwake = false;       // koi app screen ko jagaye hue hai (video, presentation)
    this._idleTicks = 0;             // idle ke dauran poll ki ginti...
    this._idleAwakeTicks = 0;        // ...aur un mein se kitni mein screen jagi hui thi
    this._lastPollAt = 0;
    this._ledgerSavedAt = 0;
    this._watcher = null;
    this._watcherRestarts = 0;
    this._watcherTimer = null;
    this._macTimer = null;
    this._macFailures = 0;
    this._pollTimer = null;
    this._tickTimer = null;
    this._saveTimer = null;
    this._dirty = false;
    this._power = null;              // powerMonitor listeners, taake stop par hat sakein
  }

  setWindow(win) { this.mainWindow = win; }

  // ── On / off ──────────────────────────────────────────────────────────────

  configure({ enabled } = {}) {
    if (enabled) this.start();
    else {
      this.stop();
      this._dropStaleDiary();
    }
    return this.status();
  }

  status() {
    return { ok: true, running: this.running, focusWatcher: Boolean(this._watcher || this._macTimer) };
  }

  start() {
    if (this.running) return;
    this.running = true;
    const now = Date.now();

    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const saved = JSON.parse(fs.readFileSync(this.diaryPath, 'utf8'));
      this.timeline.load(saved.entries, now);
      this.ledger.load(saved.days, now);
    } catch { /* pehli dafa, ya file kharab — khali diary se shuru */ }

    // Ek process mein ek hi "khula" — setting baar baar on/off ho to diary mein
    // har dafa "KnockDesk was opened" na likha jaye.
    if (!this._startLogged) {
      this._startLogged = true;
      this.timeline.add({ t: this._bootAt, kind: 'start' });
    }
    this._activeSince = now;
    this._away = false;
    this._lastPollAt = now;
    this._idleTicks = 0;
    this._idleAwakeTicks = 0;
    this._markDirty();

    this._power = {
      'lock-screen': () => this._onLock(),
      'unlock-screen': () => this._onUnlock(),
      suspend: () => this._onSuspend(),
      resume: () => this._onResume(),
    };
    for (const [name, fn] of Object.entries(this._power)) powerMonitor.on(name, fn);

    this._pollTimer = setInterval(() => this._poll(), POLL_MS);
    this._tickTimer = setInterval(() => this._tick(), TICK_MS);
    this._startFocusWatcher();
    console.log('[Awareness] Started.');
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this._power) {
      for (const [name, fn] of Object.entries(this._power)) powerMonitor.removeListener(name, fn);
      this._power = null;
    }
    for (const key of ['_pollTimer', '_tickTimer', '_macTimer']) {
      if (this[key]) { clearInterval(this[key]); this[key] = null; }
    }
    for (const key of ['_watcherTimer', '_saveTimer']) {
      if (this[key]) { clearTimeout(this[key]); this[key] = null; }
    }
    this.killWatcherSync();
    this._focus = null;
    this._micInCallBy = null;
    this._screenAwake = false;
    this._dirty = true;
    this._save();
    console.log('[Awareness] Stopped.');
  }

  /**
   * Awareness band hai aur diary purani ho chuki — disk se hata do.
   *
   * Band karne ka matlab hai "mujhe mat dekho". Us ke baad bhi kal ki windows
   * ke naam ek file mein pare rehna us waade ke khilaf hai. 18 ghante ki mohlat
   * is liye ke koi meeting ke liye band kar ke dobara on kare to din ki diary
   * na jaye. Renderer har boot par `configure` bhejta hai, to ye wahin chal jata hai.
   */
  _dropStaleDiary() {
    fs.stat(this.diaryPath, (err, stat) => {
      if (err || Date.now() - stat.mtimeMs < KEEP_MS) return;
      fs.unlink(this.diaryPath, () => { /* pehle hi gayi */ });
    });
  }

  /** Quit ke har raste par (crash sweep bhi) — sync, taake process peeche na rahe. */
  killWatcherSync() {
    const child = this._watcher;
    this._watcher = null;
    if (!child) return;
    try { child.removeAllListeners('exit'); child.kill(); } catch { /* pehle hi ja chuka */ }
  }

  /** Input nahi, magar screen par kuch chal raha hai — user dekh raha hai. */
  _watching(idle) {
    return this._screenAwake && idle >= WATCH_AFTER_S && idle < WATCH_MAX_IDLE_S;
  }

  /**
   * Renderer ki ghari. Saath wo signals bhi jate hain jin se engine "lamhe"
   * pehchanta hai (src/lib/awareness/moments.ts): mojoodgi, call, screen jagi
   * hui hai ya nahi, aur bina waqfe ke kitni der se kaam. Sab muft — engine ko
   * in ke liye snapshot ya model nahi maangna parta.
   */
  _tick() {
    let idle = 0;
    try { idle = powerMonitor.getSystemIdleTime(); } catch { /* */ }
    this._emit({
      type: 'tick', idleSeconds: idle, away: this._away, locked: this._locked,
      watching: this._watching(idle), micInCallBy: this._micInCallBy,
      screenAwake: this._screenAwake,
      stretchMinutes: Math.max(0, Math.round((Date.now() - this._activeSince) / 60000)),
    });
  }

  // ── Idle / lock / sleep ───────────────────────────────────────────────────

  _poll() {
    if (!this.running) return;
    const now = Date.now();
    let idle = 0;
    try { idle = powerMonitor.getSystemIdleTime(); } catch { return; }
    // Neend ya atki hui ghari ke baad ek poll "ghanton" ka na ban jaye.
    const delta = Math.max(0, Math.min(now - (this._lastPollAt || now), 3 * POLL_MS));
    this._lastPollAt = now;

    if (idle >= AWAY_AFTER_S) {
      this._idleTicks += 1;
      if (this._screenAwake) this._idleAwakeTicks += 1;
    } else if (!this._away) {
      this._idleTicks = 0;
      this._idleAwakeTicks = 0;
    }

    // Screen par kuch chal raha ho to idle "uth gaya" nahi — ek hadd tak.
    const watching = this._screenAwake && idle < WATCH_MAX_IDLE_S;
    if (!this._away && idle >= AWAY_AFTER_S && !watching) {
      this._away = true;
      // Video abhi abhi ruki ho to wo ab tak dekh raha tha: ghair-hazri abhi se.
      this._awaySince = this._watchedWhileIdle() ? now : now - idle * 1000;
      this.timeline.add({ t: this._awaySince, kind: 'away' });
      this._markDirty();
    } else if (this._away && idle < 10 && !this._locked) {
      this._comeBack(now, 'back');
    }

    if (!this._locked && !this._away && (idle < AWAY_AFTER_S || watching)) {
      this.ledger.note(now, this._focus ? (this._focus.own ? 'KnockDesk' : this._focus.app) : '', delta);
      if (now - this._ledgerSavedAt >= LEDGER_SAVE_MS) {
        this._ledgerSavedAt = now;
        this._markDirty();
      }
    }
    if (this.timeline.prune(now)) this._markDirty();
  }

  _watchedWhileIdle() {
    return this._idleTicks > 0 && this._idleAwakeTicks / this._idleTicks >= WATCHED_SHARE;
  }

  _comeBack(now, type) {
    const awayMs = this._awaySince ? now - this._awaySince : 0;
    const mins = Math.max(0, Math.round(awayMs / 60000));
    const watched = this._watchedWhileIdle();
    this._away = false;
    this._awaySince = 0;
    this._idleTicks = 0;
    this._idleAwakeTicks = 0;
    this.timeline.add({ t: now, kind: 'back', mins });
    if (awayMs >= LONG_AWAY_MS) this._activeSince = now;
    this._markDirty();
    this._emit({ type, awayMinutes: mins, watched });
  }

  _onLock() {
    this._locked = true;
    this.timeline.add({ t: Date.now(), kind: 'lock' });
    this._markDirty();
  }

  _onUnlock() {
    const now = Date.now();
    this._locked = false;
    this.timeline.add({ t: now, kind: 'unlock' });
    // Lock ke dauran idle ghari chalti rehti hai; unlock khud "wapsi" hai.
    if (this._away) this._comeBack(now, 'unlock');
    else this._emit({ type: 'unlock', awayMinutes: 0 });
    this._markDirty();
  }

  _onSuspend() {
    this._suspendedAt = Date.now();
    this.timeline.add({ t: this._suspendedAt, kind: 'sleep' });
    this._dirty = true;
    this._save();
  }

  _onResume() {
    const now = Date.now();
    const sleptMs = this._suspendedAt ? now - this._suspendedAt : 0;
    const mins = Math.max(0, Math.round(sleptMs / 60000));
    this._suspendedAt = 0;
    this.timeline.add({ t: now, kind: 'wake', mins });
    if (sleptMs >= LONG_AWAY_MS) this._activeSince = now;
    // So kar uthne par purani "away" ki ginti be-maani hai — wake hi wapsi hai.
    this._away = false;
    this._awaySince = 0;
    this._idleTicks = 0;
    this._idleAwakeTicks = 0;
    this._lastPollAt = now;
    this._markDirty();
    this._emit({ type: 'wake', awayMinutes: mins });
  }

  // ── Saamne wali window ────────────────────────────────────────────────────

  _startFocusWatcher() {
    if (!this.running) return;
    if (isWindows) return this._startWindowsWatcher();
    if (isMac) return this._startMacWatcher();
  }

  _startWindowsWatcher() {
    if (this._watcher) return;
    let scriptPath;
    try {
      scriptPath = path.join(this.dir, 'focus-watch.ps1');
      fs.writeFileSync(scriptPath, FOCUS_WATCH_PS1, 'utf8');
    } catch (err) {
      console.warn('[Awareness] Focus watcher script likhi nahi gayi:', err.message);
      return;
    }

    let child;
    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath, '-ParentPid', String(process.pid), '-IntervalMs', String(FOCUS_INTERVAL_MS),
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      console.warn('[Awareness] Focus watcher shuru nahi hua:', err.message);
      return;
    }
    this._watcher = child;
    const startedAt = Date.now();

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.replace(/^﻿/, '').trim();
        if (!line) continue;
        try { this._onFocus(JSON.parse(line)); } catch { /* adhoori line */ }
      }
    });
    child.on('error', () => { /* 'exit' sambhal leta hai */ });
    child.once('exit', () => {
      if (this._watcher !== child) return;
      this._watcher = null;
      // Watcher ke baghair ye signal purana ho jata hai — jhoota "dekh raha hai" na rahe.
      this._screenAwake = false;
      this._micInCallBy = null;
      if (!this.running) return;
      // Der tak theek chala ho to ginti saaf — ye ek achanak maut thi, loop nahi.
      if (Date.now() - startedAt > 10 * 60 * 1000) this._watcherRestarts = 0;
      if (this._watcherRestarts >= WATCHER_MAX_RESTARTS) {
        console.warn('[Awareness] Focus watcher baar baar band ho raha hai — window ke naam ke baghair chalenge.');
        this._focus = null;
        return;
      }
      this._watcherRestarts += 1;
      this._watcherTimer = setTimeout(() => this._startWindowsWatcher(), 5000 * this._watcherRestarts);
    });
  }

  _startMacWatcher() {
    if (this._macTimer) return;
    let macGetActiveWindow;
    try { ({ macGetActiveWindow } = require('./platform-utils')); } catch { return; }
    if (typeof macGetActiveWindow !== 'function') return;
    const read = async () => {
      try {
        const info = await macGetActiveWindow();
        this._macFailures = 0;
        this._onFocus({ app: info.processName, title: info.title, pid: info.pid });
      } catch {
        // Accessibility ki ijazat na ho to har dafa fail hoga — poochte rehna faltu.
        this._macFailures += 1;
        if (this._macFailures >= 3 && this._macTimer) { clearInterval(this._macTimer); this._macTimer = null; }
      }
    };
    this._macTimer = setInterval(read, MAC_FOCUS_INTERVAL_MS);
    void read();
  }

  /** Watcher ki mic list mein se "call" dhoondna — apni app ko chhor kar. */
  _setMic(list) {
    if (typeof list !== 'string') return;
    const own = path.basename(process.execPath).toLowerCase();
    const caller = list.split('|')
      .map((name) => name.trim())
      .filter((name) => name && name.toLowerCase() !== own && !/knockdesk|knockdesk ai/i.test(name))
      .find((name) => CALL_APPS.test(name));
    this._micInCallBy = caller ? caller.replace(/\.exe$/i, '').replace(/_[a-z0-9]{10,}$/i, '') : null;
  }

  _onFocus(raw) {
    if (!this.running || !raw) return;
    this._setMic(raw.mic);
    if (typeof raw.display === 'boolean') this._screenAwake = raw.display;
    const now = Date.now();
    // KnockDesk ki apni window: process ka naam dev mein "electron" hota hai, jo
    // model ke liye be-maani hai.
    let ownWindow = false;
    try { ownWindow = Boolean(BrowserWindow.getFocusedWindow()); } catch { /* band ho rahi hai */ }
    const focus = ownWindow
      ? { app: OWN_APP_NAME, title: '', private: false }
      : sanitizeFocus(raw.app, raw.title);
    const sameApp = this._focus && this._focus.app === focus.app;
    const changed = !sameApp || this._focus.title !== focus.title;
    this._focus = { ...focus, own: ownWindow, since: sameApp ? this._focus.since : now };
    if (this.timeline.noteFocus(focus, now)) this._markDirty();
    // Engine isi par sochta hai (thehrao wo khud deta hai). Title yahan nahi
    // jata — engine snapshot se leta hai.
    if (changed) this._emit({ type: 'focus', own: ownWindow, appChanged: !sameApp });
  }

  // ── Renderer ke liye ──────────────────────────────────────────────────────

  snapshot() {
    const now = Date.now();
    let idle = 0;
    let onBattery = false;
    try { idle = powerMonitor.getSystemIdleTime(); } catch { /* */ }
    try { onBattery = powerMonitor.isOnBatteryPower(); } catch { /* */ }
    return {
      ok: true,
      running: this.running,
      now,
      idleSeconds: idle,
      away: this._away,
      locked: this._locked,
      watching: this._watching(idle),
      onBattery,
      active: this._focus,
      micInCallBy: this._micInCallBy,
      focusWatcher: Boolean(this._watcher || this._macTimer),
      activeStretchMinutes: Math.max(0, Math.round((now - this._activeSince) / 60000)),
      appOpenMinutes: Math.max(0, Math.round((now - this._bootAt) / 60000)),
      digest: this.running ? this.timeline.digest(now) : [],
      today: this.running ? this.ledger.today(now) : null,
      recentDays: this.running ? this.ledger.lines(now) : [],
    };
  }

  /**
   * Screen ki ek tasveer — sirf jab dimaagh maange.
   *
   * Us screen ki jahan cursor hai, 1280px tak chhoti, JPEG. Teen inkaar:
   *
   *   private window  -> jis cheez ka title hum model ko nahi dete, us ki
   *                      tasveer dena us se bhi bura hota.
    *   KnockDesk ki apni -> us tasveer mein KnockDesk ki apni baatein aur logs hote
    *   window               hain; test mein wo unhi par tabsra karne laga tha
   *                      ("Core Log keh raha hai…") — apne aap se baatein.
   *   lock
   */
  async captureScreen() {
    if (!this.running) return { ok: false, error: 'awareness_off' };
    if (this._focus && this._focus.private) return { ok: false, error: 'private_window' };
    if (this._focus && this._focus.own) return { ok: false, error: 'knockdesk_window' };
    if (this._locked) return { ok: false, error: 'locked' };
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: SCREENSHOT_MAX });
      const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
      if (!source || source.thumbnail.isEmpty()) return { ok: false, error: 'no_screen_source' };
      // Tasveer bante bante awareness band ho gayi ho to wo bahar na jaye.
      if (!this.running) return { ok: false, error: 'awareness_off' };
      const jpeg = source.thumbnail.toJPEG(62);
      return { ok: true, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`, bytes: jpeg.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Dimaagh ke faisle disk par — `awareness/awareness.log`, ek line fi faisla.
   *
   * Awareness peeche chalti hai aur dev ke bahar console nazar nahi aata; is
   * file ke baghair "KnockDesk kyun nahi bola" ka jawab dhoondna mumkin nahi tha.
   * 1 MB par purani file `.old` ban jati hai — ye kabhi barhti nahi rehti.
   */
  writeLog({ type, message, details } = {}) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, 'awareness.log');
      try {
        if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.old`);
      } catch { /* file abhi bani nahi */ }
      let extra = '';
      if (details !== undefined && details !== null) {
        extra = typeof details === 'string' ? details : JSON.stringify(details);
        extra = ` | ${extra.replace(/\s+/g, ' ').slice(0, 600)}`;
      }
      const line = `${new Date().toISOString()} [${String(type || 'info')}] ${String(message || '').slice(0, 300)}${extra}\n`;
      fs.appendFileSync(file, line, 'utf8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ── Andar ke kaam ─────────────────────────────────────────────────────────

  _emit(payload) {
    const win = this.mainWindow;
    try {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('awareness:event', { ...payload, at: Date.now() });
      }
    } catch { /* window band ho rahi hai */ }
  }

  _markDirty() {
    this._dirty = true;
    if (this._saveTimer || !this.running) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._save(); }, SAVE_DEBOUNCE_MS);
  }

  _save() {
    if (!this._dirty) return;
    this._dirty = false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.diaryPath, JSON.stringify({
        savedAt: Date.now(), entries: this.timeline.toJSON(), days: this.ledger.toJSON(),
      }), 'utf8');
    } catch (err) {
      console.warn('[Awareness] Diary save nahi hui:', err.message);
    }
  }
}

module.exports = { AwarenessManager };
