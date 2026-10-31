// ═══════════════════════════════════════════════════════════════
//  ComputerOverlay — screen par "agent chala raha hai" ka nishan
//
//  Jab computer-use agent kaam karta hai to primary screen par:
//    - kinaron ka Apple-style glow (aura), cursor ke peeche comet, click par ripple
//    - upar beech mein HUD: step, soch, waqt, source, aur hover par khulne wala
//      details panel (poora task + har step ki activity). HUD par koi button
//      nahi aur wo click-through hai — agent ke clicks aar-paar jate hain.
//  Ye HAR app ke upar dikhta hai — user chahe kisi bhi screen par ho.
//
//  Rendering ek alag Python process karta hai (knockdesk-computer/overlay_hud.py),
//  Electron ki window nahi. Wajah test se nikli: agent har step par screenshot
//  leta hai, aur Electron ki transparent window ko screenshot se nikalne par
//  (content protection) wo KAALI aa jati hai — agent andha. Windows ka layered
//  window (UpdateLayeredWindow + WDA_EXCLUDEFROMCAPTURE) screenshot mein bilkul
//  nahi aata. Isi liye tasveer Python banata hai; yahan sirf state hai.
//
//  Ye class state ki maalik hai: manager ke events ek chhote reducer se guzar
//  kar poora snapshot Python ko jata hai (`{"cmd":"state"}`). Python ka
//  `{"event":"stop"}` manager.stop() tak pohnchta hai — protocol mein hai,
//  magar HUD ab koi Stop button nahi dikhata (rokna: mouse hilao, Ctrl+Alt+Esc,
//  voice), is liye abhi koi UI isay bhejta nahi.
//
//  Process pehle task par uthta hai (~1 s), phir garam rehta hai; 15 minute
//  koi task na ho to band. Python na mile to overlay chup-chaap nahi chalta —
//  agent par koi asar nahi.
// ═══════════════════════════════════════════════════════════════

const path = require('path');
const readline = require('readline');

const LINGER_MS = 6000;           // natija itni der dikhao, phir chhupao
const LEAVE_MS = 450;             // is se itna pehle exit animation shuru
const IDLE_MS = 15 * 60 * 1000;
const HISTORY_MAX = 40;          // itne steps HUD ke details panel ke liye yaad rakho

class ComputerOverlay {
  /**
   * @param {{ onStop?: (taskId: string) => void, spawnProcess?: Function, runtime?: object }} opts
   *   `spawnProcess` / `runtime` sirf test ke liye inject hote hain.
   */
  constructor({ onStop, spawnProcess, runtime } = {}) {
    this.onStop = typeof onStop === 'function' ? onStop : () => {};
    this._spawn = spawnProcess || require('child_process').spawn;
    this._runtime = runtime || require('./computer-runtime');
    this.child = null;
    this.ready = false;
    this.state = { phase: 'idle' };
    this.layout = null;             // Python se aaya: { pill:[x,y,w,h], stop:[x,y,w,h], panel:[x,y,w,h]|null }
    this._linger = null;
    this._leave = null;
    this._idle = null;
    this._destroyed = false;
    this._warned = false;
  }

  // ── Events (ComputerManager._broadcast se) ───────────────────────────────

  event(ev) {
    if (this._destroyed || !ev || !ev.event) return;
    const s = this.state;
    switch (ev.event) {
      case 'task_queued':
        this._clearTimers();
        this.state = {
          phase: 'starting', id: ev.id, task: ev.task, source: ev.source || 'unknown',
          maxSteps: ev.max_steps, step: 0, startedAt: Date.now(), history: [],
        };
        this._ensureProcess();
        break;
      case 'task_starting':
        // Sidecar ki dhadkan: "zinda hoon, agent load kar raha hoon". Pehle
        // ise gira diya jata tha, to HUD par sirf "Waking up the agent…" khara
        // rehta aur thandi machine par wo 2-3 minute atka hua lagta tha. Ab
        // seconds saath chalte hain — user ko dikhta hai ke kaam ho raha hai.
        if (s.phase !== 'starting' || (ev.id && s.id && ev.id !== s.id)) return;
        this.state = { ...s, loadingFor: Number(ev.elapsed) || 0 };
        break;
      case 'task_started':
        if (s.phase === 'idle' || (ev.id && s.id && ev.id !== s.id)) return;
        this.state = { ...s, phase: 'running', id: ev.id || s.id, maxSteps: ev.max_steps ?? s.maxSteps };
        break;
      case 'step':
        if (s.phase === 'idle' || (ev.id && s.id && ev.id !== s.id)) return;
        this.state = {
          ...s, phase: s.phase === 'stopping' ? 'stopping' : 'running',
          step: ev.step, maxSteps: ev.max_steps ?? s.maxSteps, thought: ev.thought || s.thought, action: ev.action,
          // HUD ke "details" panel ke liye har step ki ek line — aakhri HISTORY_MAX.
          history: (s.history || []).concat([{
            step: ev.step, thought: ev.thought || '', action: ev.action || '',
            at: Math.max(0, Date.now() - (s.startedAt || Date.now())),
          }]).slice(-HISTORY_MAX),
        };
        break;
      case 'stopping':
        if (s.phase === 'idle' || s.phase === 'done') return;
        this.state = { ...s, phase: 'stopping' };
        break;
      case 'task_done':
        if (s.phase === 'idle' || (ev.id && s.id && ev.id !== s.id)) return;
        this.state = {
          ...s, phase: 'done', status: ev.status, summary: ev.summary,
          steps: ev.steps ?? s.step, finishedAt: Date.now(),
        };
        this._scheduleHide();
        break;
      case 'process_exit':
        // `task_done` pehle aa chuka hota hai (manager _finish se). Agar nahi
        // aaya — matlab task ke baghair process gira — to bas chhupa do.
        if (s.phase !== 'done' && s.phase !== 'idle') this._hideNow();
        return;
      default:
        return;
    }
    this._push();
  }

  getState() { return { ...this.state }; }

  // ── Python process ──────────────────────────────────────────────────────

  _ensureProcess() {
    if (this.child) return;
    const python = this._runtime.resolvePython();
    const runner = this._runtime.resolveRunnerScript();
    if (!python || !runner) {
      if (!this._warned) { this._warned = true; console.warn('[Overlay] Python runtime nahi mila — overlay ke baghair chal rahe hain.'); }
      return;
    }
    const script = path.join(path.dirname(runner), 'overlay_hud.py');
    let child;
    try {
      child = this._spawn(python, [script], {
        cwd: path.dirname(script),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      console.warn('[Overlay] spawn fail:', err.message);
      return;
    }
    this.child = child;
    this.ready = false;
    readline.createInterface({ input: child.stdout }).on('line', (line) => this._onLine(child, line));
    readline.createInterface({ input: child.stderr }).on('line', (line) => { if (line.trim()) console.log('[Overlay/py]', line); });
    child.stdin.on('error', () => { /* process ja chuka — exit handler sambhalta hai */ });
    child.on('error', (err) => this._onExit(child, err.message));
    child.on('exit', (code, signal) => this._onExit(child, `exit ${code}${signal ? ` (${signal})` : ''}`));
  }

  _onLine(child, line) {
    if (child !== this.child) return;
    let ev;
    try { ev = JSON.parse(line); } catch { console.log('[Overlay/py]', line); return; }
    switch (ev.event) {
      case 'ready':
        this.ready = true;
        this._push();
        break;
      case 'layout':
        this.layout = { pill: ev.pill || null, stop: ev.stop || null, panel: ev.panel || null };
        break;
      case 'stop': {
        const id = String(ev.id || this.state.id || '');
        try { this.onStop(id); } catch (err) { console.warn('[Overlay] stop fail:', err.message); }
        break;
      }
      case 'error':
        console.warn('[Overlay/py] error:', ev.message);
        break;
      default:
        break;
    }
  }

  _onExit(child, reason) {
    if (child !== this.child) return;
    console.log('[Overlay] process band:', reason);
    this.child = null;
    this.ready = false;
    this.layout = null;
  }

  _send(msg) {
    const child = this.child;
    if (!child || !child.stdin || !child.stdin.writable) return false;
    try { child.stdin.write(JSON.stringify(msg) + '\n'); return true; } catch { return false; }
  }

  _push() {
    if (!this.child || !this.ready) return;
    this._send({ cmd: 'state', state: this.state });
  }

  _hideNow() {
    this._clearTimers();
    this.state = { phase: 'idle' };
    this._send({ cmd: 'hide' });
    this._armIdle();
  }

  _scheduleHide() {
    this._clearTimers();
    this._leave = setTimeout(() => {
      this._leave = null;
      this.state = { ...this.state, leaving: true };
      this._push();
    }, Math.max(0, LINGER_MS - LEAVE_MS));
    this._linger = setTimeout(() => { this._linger = null; this._hideNow(); }, LINGER_MS);
    this._leave.unref?.();
    this._linger.unref?.();
  }

  _clearTimers() {
    if (this._leave) { clearTimeout(this._leave); this._leave = null; }
    if (this._linger) { clearTimeout(this._linger); this._linger = null; }
    if (this._idle) { clearTimeout(this._idle); this._idle = null; }
  }

  _armIdle() {
    if (this._idle) clearTimeout(this._idle);
    this._idle = setTimeout(() => {
      this._idle = null;
      if (this.state.phase === 'idle') this._kill('idle');
    }, IDLE_MS);
    this._idle.unref?.();
  }

  _kill(why) {
    const child = this.child;
    if (!child) return;
    console.log('[Overlay] process band kar rahe hain:', why);
    this.child = null;
    this.ready = false;
    try { child.stdin.write(JSON.stringify({ cmd: 'shutdown' }) + '\n'); } catch { /* */ }
    try { child.stdin.end(); } catch { /* */ }
    setTimeout(() => {
      try { child.kill(); } catch { /* */ }
      // Sidecar ki tarah HUD bhi do PID hai (venv trampoline + asli Python) —
      // akela `kill()` neeche wale ko nahi chhoota. Dekho computer-runtime.
      this._killTree(child.pid, false);
    }, 1500).unref?.();
  }

  _killTree(pid, sync) {
    try { this._runtime.killProcessTree?.(pid, { sync }); } catch { /* ja chuka */ }
  }

  /** App band ho rahi hai. */
  destroy() {
    this._destroyed = true;
    this._clearTimers();
    this.state = { phase: 'idle' };
    if (this.child) {
      const child = this.child;
      this.child = null;
      try { child.stdin.write(JSON.stringify({ cmd: 'shutdown' }) + '\n'); } catch { /* */ }
      try { child.stdin.end(); } catch { /* */ }
      try { child.kill(); } catch { /* */ }
      // Sync: app nikal rahi hai, async kill kabhi chalta hi nahi.
      this._killTree(child.pid, true);
    }
  }
}

module.exports = { ComputerOverlay, LINGER_MS };
