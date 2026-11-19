// ═══════════════════════════════════════════════════════════════
//  ComputerManager — Agent S3 sidecar ka maalik (resident service)
//
//  KnockDesk mein "computer use" ka ek hi darwaza yahi hai. Voice assistant
//  (renderer, IPC se) aur Hermes (plugin, local bridge se) dono yahin aate
//  hain, aur dono ek hi Python sidecar (knockdesk-computer/runner.py) par jate
//  hain. Mouse ek hai, is liye ek waqt mein ek task — doosra `busy` pata hai.
//
//  Zindagi — Hermes ki tarah, Photoshop ki tarah: ek dafa khulta hai, khula
//  rehta hai:
//    - Credentials aate hi (sign-in ke baad, Hermes tayyar hone par) sidecar
//      uthta hai aur agent ka dimagh (gui_agents, ~2700 modules) USI WAQT
//      background mein load hota hai. `ready` sirf load ke BAAD aata hai.
//    - App band hone tak zinda. Koi idle-kill nahi.
//    - Mar jaye (crash, hang) to supervisor khud dobara uthata hai — backoff
//      ke saath; 5 dafa lagatar na uthe to ruk jata hai (agla task ya nayi
//      config phir koshish karwati hai).
//    - Stop = TASK rukta hai, process nahi. Sidecar chalti hui cloud call
//      kaat deta hai aur 1-2 s mein task_done deta hai; agent loaded rehta
//      hai. Sirf asli hang par (STOP_GRACE ke baad) process marta hai — aur
//      supervisor foran naya utha kar chupke se garam kar leta hai.
//    - App band = sab band. `shutdown()` supervisor ko rokta hai aur poora
//      process tree sync maarta hai. Kuch bhi peeche nahi chalta.
//
//  Pehle aisa nahi tha: sidecar pehle task par uthta, agent tab load hota
//  (26-500 s is machine par), har stop 8 s baad process maar deta (kal ke log
//  mein 22 ke 22 stops), aur 2 ghante idle par band. Har agla task thanda —
//  HUD par "Waking up the agent…" minute tak. Ye file usi masle ka jawab hai.
//
//  Har event renderer ko `computer:event` par jata hai (HUD ke liye), chahe
//  task kis ne bhi shuru kiya ho.
// ═══════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const { app, globalShortcut } = require('electron');
const readline = require('readline');
const crypto = require('crypto');
const { resolvePython, resolveTesseract, resolveRunnerScript, describeRuntime, restoreSystemCursors, killProcessTree } = require('./computer-runtime');

const num = (name, dflt) => Number(process.env[name]) || dflt;

// Credentials aane ke itni der baad sidecar uthao. Renderer `configure` Hermes
// ke tayyar hone par bhejta hai — us waqt tak boot ka sab se bhaari hissa guzar
// chuka hota hai; ye chhota sa waqfa bas AgentTown waghaira ko saans dene ke liye.
const BOOT_DELAY_MS = num('STONIC_COMPUTER_BOOT_DELAY_MS', 5 * 1000);
// Load ke dauran sidecar har 3 s `loading` ki dhadkan bhejta hai. Itni der
// khamoshi = process hang → maar kar dobara.
const LOAD_STALL_MS = num('STONIC_COMPUTER_LOAD_STALL_MS', 30 * 1000);
// Dhadkan ke bawajood itni der mein load poora na ho to bhi dobara. Is machine
// par 8.4 minute napa gaya hai — 15 sirf gunjaish hai.
const LOAD_HARD_CAP_MS = num('STONIC_COMPUTER_LOAD_HARD_CAP_MS', 15 * 60 * 1000);
// Supervisor ka backoff: base × [1, 3, 10, 20, 40], zyada se zyada 2 minute.
const RESTART_BACKOFF_MS = num('STONIC_COMPUTER_RESTART_BACKOFF_MS', 3 * 1000);
const RESTART_BACKOFF_STEPS = [1, 3, 10, 20, 40];
const RESTART_MAX_MS = 2 * 60 * 1000;
// Itni dafa lagatar process `ready` tak na pohnche to haar maan lo (state 'error').
const MAX_START_FAILURES = 5;
// `run` bhejne ke baad itni der mein `task_started` na aaye to sidecar ne task
// uthaya hi nahi. Agent pehle se loaded hota hai, is liye asal mein ye 1 s se
// kam hai — 15 s sirf gunjaish. Us par process badal kar wohi task EK dafa
// dobara; phir bhi na chale to saaf error.
const START_TIMEOUT_MS = num('STONIC_COMPUTER_START_TIMEOUT_MS', 15 * 1000);
// Sidecar ki dhadkan (`task_starting`) start-timer ko aage sarkati hai — is
// hadd tak (misal: pichhle stop ka thread abhi mouse chhor raha ho).
const START_HARD_CAP_MS = num('STONIC_COMPUTER_START_HARD_CAP_MS', 3 * 60 * 1000);
// Task aaya magar agent abhi load ho raha hai: itni der intezaar, phir saaf error.
const PENDING_MAX_MS = num('STONIC_COMPUTER_PENDING_MAX_MS', 10 * 60 * 1000);
// Stop ke baad `task_done` ka intezaar. Sidecar cloud call kaat kar 1-2 s mein
// deta hai; ye sirf asli hang ka pehra hai — us par process marta hai.
const STOP_GRACE_MS = num('STONIC_COMPUTER_STOP_GRACE_MS', 12 * 1000);
// Ek task zyada se zyada itni der. `max_steps` step GIN-ta hai, waqt nahi —
// aur ek atka hua upstream call kisi step ki ginti mein nahi aata. Hermes
// plugin ki apni hadd (20 min) is se thori kam hai, jaan bujh kar.
const TASK_WATCHDOG_MS = 22 * 60 * 1000;
const RESULT_HISTORY = 20;
const DEFAULT_MAX_STEPS = 50;
const HARD_MAX_STEPS = 120;
const EMERGENCY_SHORTCUT = 'Control+Alt+Escape';

// _killChild ki wo wajhein jin ka matlab "task shuru hi nahi hua" hai — in par
// _onExit task ko naakaam nahi likhta, naye process par dobara bhejta hai.
const START_FAILURES = new Set(['start timeout', 'busy', 'not delivered']);

// Gateway par computer-use ka apna raasta (knockdesk-cloud-gateway/src/computer.js).
// OpenAI client is ke aage `/chat/completions` khud lagata hai.
const GATEWAY_COMPUTER_PATH = '/v1/computer';

// Lifetime (Custom API) ka rasta: user ki OpenRouter key, seedha OpenRouter.
// Models wohi jo gateway Cloud par chalata hai (knockdesk-cloud-gateway/src/config.js
// COMPUTER_PLANNER_MODEL / COMPUTER_GROUNDING_MODEL) — OpenRouter ke naamon ke
// saath. Dono OpenRouter par mojood hain, is liye ek hi key kaafi hai.
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';
const BYOK_PLANNER_MODEL = 'openai/gpt-5.6-luna';
const BYOK_GROUNDING_MODEL = 'bytedance/ui-tars-1.5-7b';
// Voice/agent ye jumla user ko suna dete hain — is liye saaf aur kaam ka.
const BYOK_NO_KEY_ERROR = 'Computer use on your own API keys needs an OpenRouter API key. Tell the user to add it in Settings → AI Engine, and do not retry.';
// Renderer is code se pehchanta hai (matn se nahi) aur "key lagayein" ka card
// kholta hai — wohi naam jo src/lib/api-issue.ts mein hain.
const BYOK_NO_KEY_CODE = 'no_key';

class ComputerManager {
  constructor() {
    this.mainWindow = null;
    this.child = null;
    this.state = 'idle';            // idle | starting (load ho raha) | ready (agent loaded) | error
    this.error = null;
    this.screen = null;
    this.current = null;            // { id, task, source, startedAt, step, maxSteps, status, dispatchedAt }
    this.results = new Map();       // id -> result (aakhri RESULT_HISTORY)
    this.waiters = new Map();       // id -> Set<resolve>
    this._bootTimer = null;         // credentials ke baad pehla uthna
    this._restartTimer = null;      // supervisor ka agla uthna
    this._loadStallTimer = null;    // load ki dhadkan ka pehra
    this._loadCapTimer = null;      // load ki kul hadd
    this._stopTimer = null;
    this._startTimer = null;        // "run bheja, task_started nahi aaya" ka pehra
    this._pendingTimer = null;      // "task aaya, agent abhi load ho raha" ka pehra
    this._watchdog = null;
    this._shortcutOn = false;
    this._currentOwner = null;      // kaunsa child process abhi wala task chala raha hai
    this._shuttingDown = false;
    this._failures = 0;             // lagatar kitne process `ready` tak nahi pohnche
    this._restartAfterTask = false; // config badli jab task chal raha tha
    this._loadingSince = 0;
    this._loadingFor = 0;
    // Renderer se aaya hua cloud config. Env overrides (dev) is par jeet-te hain.
    this._cloud = { baseUrl: null, apiKey: null };
    // Lifetime (Custom API): user ki apni OpenRouter key, SEEDHA OpenRouter.
    // `_byokProvider` main.js deta hai — ijazat (server ka license) aur key
    // dono main process ke paas hain, renderer ke nahi. Dekho configure().
    this._mode = 'cloud';           // 'cloud' | 'byok'
    this._byokKey = null;
    this._byokProvider = null;      // { allowed(): boolean, getKey(): string|null }
    this._spawnedWith = null;       // config ka fingerprint jis par ye process bana
    this._warnedOverride = false;   // dev override ki tanbeeh ek hi dafa
    this._warnedRuntime = false;    // runtime na milne ki tanbeeh ek hi dafa
    this._overlay = null;           // screen ka glow + HUD (computer-overlay.js); optional
  }

  setWindow(win) { this.mainWindow = win; }

  /**
   * Screen overlay (glow, cursor comet, HUD). Optional — na ho to agent waise
   * hi chalta hai, bas nishan nahi dikhta. Har event jo renderer ko jata hai,
   * isay bhi jata hai (dekho _broadcast).
   */
  setOverlay(overlay) { this._overlay = overlay || null; }

  /**
   * Sidecar task ke dauran Windows ka system cursor badal deta hai (agent
   * cursor) aur khatam par khud wapas karta hai. Magar agar hum ne process ko
   * ZABARDASTI maara (watchdog, stop timeout, app quit) to uska `finally`
   * kabhi nahi chalta — cursor badla ka badla reh jata. Ye backstop us soorat
   * mein user ka cursor wapas laata hai. Idempotent aur sasta hai.
   */
  _restoreCursorBackstop(why) {
    if (typeof restoreSystemCursors !== 'function') return;
    try {
      if (restoreSystemCursors()) console.log('[Computer] System cursor wapas (backstop):', why);
    } catch (err) {
      console.warn('[Computer] Cursor backstop fail:', err.message);
    }
  }

  // ── Config ──────────────────────────────────────────────────────────────

  /**
   * Renderer batata hai gateway kahan hai aur device key kya hai. Yehi wo
   * lamha hai jab sidecar uth sakta hai — is liye yahin se uthta hai.
   */
  configure({ baseUrl, apiKey, mode } = {}) {
    // ── KnockDesk local build: universal access, no licence server ───────
    //
    // Renderer sirf "byok" kehta hai — key NAHI bhejta. Key seedha disk store
    // se parhi jati hai (neeche fallback). Koi licence/ijazat ki zaroorat nahi:
    // jis ke paas apni OpenRouter key hai, computer-use usi par chalta hai.
    if (mode === 'byok') {
      const provider = this._byokProvider;
      const providerOk = !!(provider && provider.allowed());
      let orKey = providerOk ? String(provider.getKey() || '').trim() : '';
      if (!orKey) {
        // KnockDesk local build: universal access, no licence server.
        // Fall back to the user's own OpenRouter key straight from disk.
        try {
          const ks = require('./key-store');
          const path = require('path');
          const stored = ks.readKey(path.join(app.getPath('userData'), 'openrouter_key.json'), ['apiKey']);
          if (stored.saved && stored.value) orKey = stored.value;
        } catch {}
      }
      if (!orKey) {
        // User ne apni keys chuni hain magar OpenRouter ki key nahi. Pehle
        // yahan sirf error lautta tha aur pichla CLOUD config salamat rehta
        // tha — yani sidecar chup-chaap KnockDesk Cloud par chalta rehta. Ab
        // byok "bina key" par tala: sidecar band, har task saaf error ke saath
        // wapas (dekho _resolvedConfig / runTask). Cloud kabhi nahi.
        if (this._mode !== 'byok' || this._byokKey !== null) {
          this._mode = 'byok';
          this._byokKey = null;
          this._applyConfigChange();
        }
        return { ok: false, error: BYOK_NO_KEY_ERROR, code: BYOK_NO_KEY_CODE };
      }
      if (this._mode === 'byok' && this._byokKey === orKey) return { ok: true, changed: false };
      this._mode = 'byok';
      this._byokKey = orKey;
      this._applyConfigChange();
      return { ok: true, changed: true };
    }

    const base = String(baseUrl || '').replace(/\/+$/, '');
    const key = String(apiKey || '');
    if (this._mode === 'cloud' && base === this._cloud.baseUrl && key === this._cloud.apiKey) return { ok: true, changed: false };
    this._mode = 'cloud';
    this._byokKey = null;
    this._cloud = { baseUrl: base || null, apiKey: key || null };
    this._applyConfigChange();
    return { ok: true, changed: true };
  }

  /** KnockDesk: `allowed()` ab licence par nahi — sirf provider maujood ho. */
  setByokProvider(provider) {
    this._byokProvider = provider && typeof provider.allowed === 'function' && typeof provider.getKey === 'function'
      ? provider
      : null;
  }

  _applyConfigChange() {
    this._failures = 0;   // nayi config — nayi koshish
    if (this.state === 'error') { this.state = 'idle'; this.error = null; }
    if (this.child) {
      // Chalta hua process purani key par hai. Idle ho to abhi badal do —
      // supervisor naye config par foran dobara uthata hai. Busy ho to task ke baad.
      if (!this.current) this._killChild('config changed');
      else this._restartAfterTask = true;
    }
    this._startLater('config');
  }

  /**
   * KnockDesk local build: env override hamesha ijazat hai (koi billing
   * gate nahi — kharcha user ka apna hai). Pehle ye sirf unpackaged/dev
   * mein chalta tha taake packaged build mein billing bypass na ho.
   */
  _devOverrideAllowed() {
    try {
      return true;
    } catch {
      return true;
    }
  }

  _resolvedConfig() {
    const env = process.env;
    const dev = this._devOverrideAllowed();
    const devUrl = dev ? env.STONIC_COMPUTER_API_URL : null;
    const devKey = dev ? env.STONIC_COMPUTER_API_KEY : null;

    if (!dev && (env.STONIC_COMPUTER_API_URL || env.STONIC_COMPUTER_API_KEY) && !this._warnedOverride) {
      this._warnedOverride = true;
      console.warn('[Computer] KnockDesk local: env override active — sidecar seedha usi gateway par chalega.');
    }
    if (dev && devUrl && !this._warnedOverride) {
      this._warnedOverride = true;
      console.warn(`[Computer] Env override chal raha hai: ${devUrl} — kharcha user ke apne account par.`);
    }

    // Lifetime (Custom API): seedha OpenRouter, user ki apni key, ASLI model
    // naam — gateway ke logical naam ("knockdesk-computer-planner") OpenRouter
    // nahi pehchanta. Kharcha user ke OpenRouter account par; hamara meter
    // yahan jaan bujh kar nahi (wo hamara paisa hai hi nahi).
    //
    // Byok bina key = koi config nahi (null). Neeche wale Cloud raaste par
    // girna mana hai — user ne apni keys chuni hain.
    if (!devUrl && this._mode === 'byok') {
      if (!this._byokKey) {
        return { apiUrl: null, apiKey: null, route: 'byok', plannerModel: '', groundingModel: '', groundingWidth: '', groundingHeight: '' };
      }
      return {
        apiUrl: OPENROUTER_API_URL,
        apiKey: this._byokKey,
        // Runner ko batana zaroori hai ke wo user ki apni key par hai: ghalti
        // ka matn isi par badalta hai ("OpenRouter credits khatam", na ke
        // "plan renew karein" — dekho runner.py `_explain_error`).
        route: 'byok',
        plannerModel: BYOK_PLANNER_MODEL,
        groundingModel: BYOK_GROUNDING_MODEL,
        groundingWidth: '',
        groundingHeight: '',
      };
    }

    const apiUrl = devUrl
      || (this._cloud.baseUrl ? `${this._cloud.baseUrl}${GATEWAY_COMPUTER_PATH}` : null);
    const apiKey = devKey || this._cloud.apiKey || null;
    return {
      apiUrl,
      apiKey,
      route: 'cloud',
      // Ye ASLI model ke naam nahi — logical naam hain. Gateway inhein us model
      // par mor deta hai jo us waqt uske env mein set ho (config.js dekhein).
      //
      // Wajah: yahan asli naam likhne ka matlab hai ke model badalne ke liye
      // poori app (522 MB) dobara build kar ke har customer tak bhejni pare —
      // aur jab tak sab update na karein, aadhe log purane model par rahein.
      // Logical naam se wohi tabdeeli Cloud Run ke ek env var se ho jati hai.
      //
      // Dev par asli naam bhi chalte hain (gateway ki allowlist mein mojood
      // hain), taake do models ka muqabla kiya ja sake.
      plannerModel: (dev && env.STONIC_COMPUTER_PLANNER_MODEL) || 'knockdesk-computer-planner',
      groundingModel: (dev && env.STONIC_COMPUTER_GROUNDING_MODEL) || 'knockdesk-computer-grounding',
      // Grounding ke naap JAAN BUJH KAR khali. Runner inhein us screenshot se
      // khud nikalta hai jo wo model ko bhejta hai — aur wohi durust hai.
      // Pehle yahan '1920'/'1080' likha tha; 1080p screen par wo ittefaq se
      // sahi tha, magar 2K/4K par clicks button se khisak jate the. Dev par
      // override phir bhi mumkin hai.
      groundingWidth: (dev && env.STONIC_COMPUTER_GROUNDING_WIDTH) || '',
      groundingHeight: (dev && env.STONIC_COMPUTER_GROUNDING_HEIGHT) || '',
    };
  }

  isConfigured() {
    const c = this._resolvedConfig();
    return Boolean(c.apiUrl && c.apiKey);
  }

  /** Agent ki halat ek lafz mein — tools aur HUD ke liye. */
  _agentState() {
    if (this.state === 'ready' && this.child) return 'ready';
    if (this.state === 'starting' && this.child) return 'loading';
    if (this.state === 'error') return 'error';
    return 'idle';
  }

  getStatus() {
    const python = resolvePython();
    return {
      available: Boolean(python && resolveRunnerScript()),
      configured: this.isConfigured(),
      state: this.state,
      agentState: this._agentState(),
      agentReady: this._agentState() === 'ready',
      loadingFor: this.state === 'starting' && this._loadingSince ? Math.round((Date.now() - this._loadingSince) / 1000) : 0,
      error: this.error,
      busy: Boolean(this.current),
      task: this.current ? { ...this.current } : null,
      screen: this.screen,
      python,
      tesseract: resolveTesseract(),
    };
  }

  // ── Tasks ───────────────────────────────────────────────────────────────

  /**
   * Task shuru karo. FORAN lautta hai — agent loaded ho to task usi lamhe
   * chal parta hai; load ho raha ho to qatar mein (HUD "Waking up…" ke saath
   * seconds dikhata hai) aur `ready` aate hi chal parta hai. Natija
   * `waitFor(id)` se ya `computer:event` (task_done) se.
   */
  async runTask({ task, maxSteps, fast = false, source = 'unknown', overlay = true } = {}) {
    const text = String(task || '').trim();
    if (!text) return { ok: false, error: 'task is empty' };
    if (this._shuttingDown) return { ok: false, error: 'app is shutting down' };
    if (this.current) {
      return { ok: false, error: 'busy', busyWith: { id: this.current.id, task: this.current.task } };
    }
    const runtime = describeRuntime();
    if (!runtime.ok) {
      // Poori wajah console par — tool ke jawab mein sirf pehli line, warna
      // model ko screen bhar ka rasta parhna parta hai.
      console.error('[Computer] Runtime adhoora hai:\n  ' + runtime.missing.join('\n  '));
      return { ok: false, error: `computer runtime not installed — ${runtime.missing[0]}` };
    }
    if (!this.isConfigured()) {
      if (this._mode === 'byok') return { ok: false, error: BYOK_NO_KEY_ERROR, code: BYOK_NO_KEY_CODE };
      return { ok: false, error: 'computer control not configured (no cloud credentials yet)' };
    }

    const id =`cu-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const steps = Math.max(1, Math.min(Number(maxSteps) || DEFAULT_MAX_STEPS, HARD_MAX_STEPS));
    // Reserve karo PEHLE — spawn ke dauran doosri request na ghus jaye.
    // `fast`/`overlay` bhi yahan: retry par wohi task dobara bhejna hota hai.
    this.current = {
      id, task: text, source, startedAt: Date.now(), step: 0, maxSteps: steps, status: 'starting',
      fast: Boolean(fast), overlay: Boolean(overlay), dispatchedAt: null,
    };
    // Supervisor haar maan chuka ho to task ek nayi koshish hai.
    if (this.state === 'error') { this.state = 'idle'; this.error = null; this._failures = 0; }

    this._registerShortcut();
    this._armWatchdog(id);
    this._broadcast({ event: 'task_queued', id, task: text, source, max_steps: steps });

    if (this.child && this.state === 'ready') {
      this._dispatch();
    } else {
      // Agent abhi nahi hai ya load ho raha hai — qatar mein, aur process
      // foran (backoff ka intezaar nahi).
      this._armPendingTimer(id);
      this._clearRestartTimer();
      this._ensureProcess('task');
    }
    return { ok: true, taskId: id, maxSteps: steps, agentReady: this._agentState() === 'ready' && Boolean(this.current?.dispatchedAt) };
  }

  /** Chalta hua task roko (id na do to jo bhi chal raha hai). */
  stop(taskId) {
    if (!this.current || (taskId && taskId !== this.current.id)) {
      return { ok: false, error: 'no such task running' };
    }
    const id = this.current.id;
    this.current.status = 'stopping';   // start-timer ab dobara koshish na kare
    if (!this.current.dispatchedAt) {
      // Abhi sidecar tak gaya hi nahi (agent load ho raha tha) — bas chhor do.
      this._finishNotStarted(id, { status: 'stopped', summary: 'Task stopped before it started.', error: null });
      return { ok: true, taskId: id };
    }
    this._send({ cmd: 'stop', id });
    this._broadcast({ event: 'stopping', id });
    // Sidecar cloud call kaat kar 1-2 s mein task_done deta hai. Na de to wo
    // waqai atka hai — process ka khatma hi stop hai; supervisor naya uthata hai.
    if (!this._stopTimer) {
      this._stopTimer = setTimeout(() => {
        this._stopTimer = null;
        if (this.current && this.current.id === id) this._killChild('stop timeout');
      }, STOP_GRACE_MS);
    }
    return { ok: true, taskId: id };
  }

  getResult(taskId) { return this.results.get(taskId) || null; }

  /** Natije ka intezaar (long-poll). Timeout par null. */
  waitFor(taskId, timeoutMs = 60000) {
    const done = this.results.get(taskId);
    if (done) return Promise.resolve(done);
    if (!this.current || this.current.id !== taskId) return Promise.resolve(null);
    return new Promise((resolve) => {
      const set = this.waiters.get(taskId) || new Set();
      const timer = setTimeout(() => { set.delete(entry); resolve(null); }, timeoutMs);
      const entry = (result) => { clearTimeout(timer); resolve(result); };
      set.add(entry);
      this.waiters.set(taskId, set);
    });
  }

  // ── Local bridge (Hermes plugin) ────────────────────────────────────────
  //
  // knockdesk-bridge.js `/v1/computer/*` yahan bhejta hai. Auth wahan ho chuki.
  async handleBridgeRequest(req, res, url) {
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const query = new URL(req.url, 'http://127.0.0.1').searchParams;
    try {
      if (req.method === 'POST' && url === '/v1/computer/run') {
        const body = await readJson(req);
        const r = await this.runTask({
          task: body.task, maxSteps: body.max_steps, fast: body.fast, source: 'hermes',
        });
        return json(r.ok ? 202 : 409, r);
      }
      if (req.method === 'GET' && url === '/v1/computer/wait') {
        const id = query.get('id') || '';
        const timeout = Math.min(Number(query.get('timeout') || 60), 120) * 1000;
        if (!this.results.has(id) && (!this.current || this.current.id !== id)) {
          return json(404, { ok: false, error: 'unknown task' });
        }
        const result = await this.waitFor(id, timeout);
        return json(200, result ? { ok: true, done: true, result } : { ok: true, done: false, task: this.current });
      }
      if (req.method === 'POST' && url === '/v1/computer/stop') {
        const body = await readJson(req);
        return json(200, this.stop(body.id));
      }
      if (req.method === 'GET' && url === '/v1/computer/status') {
        return json(200, { ok: true, ...this.getStatus() });
      }
      return json(404, { error: 'not_found' });
    } catch (err) {
      return json(500, { ok: false, error: err.message });
    }
  }

  // ── Supervisor: uthana, zinda rakhna, dobara uthana ─────────────────────

  /** Thori der baad sidecar uthao (agar tab tak zaroorat baqi ho). */
  _startLater(why) {
    if (this._shuttingDown || this._bootTimer) return;
    this._bootTimer = setTimeout(() => {
      this._bootTimer = null;
      this._ensureProcess(why);
    }, BOOT_DELAY_MS);
    this._bootTimer.unref?.();
  }

  _clearBootTimer() {
    if (this._bootTimer) { clearTimeout(this._bootTimer); this._bootTimer = null; }
  }

  /** Process na ho to abhi uthao. Kabhi throw nahi karta. */
  _ensureProcess(why) {
    if (this._shuttingDown || this.child) return;
    if (this._failures >= MAX_START_FAILURES) {
      this.state = 'error';
      return;
    }
    if (!this.isConfigured()) return;
    const runtime = describeRuntime();
    if (!runtime.ok) {
      if (!this._warnedRuntime) {
        this._warnedRuntime = true;
        console.warn('[Computer] Runtime adhoora hai — sidecar nahi uth sakta:\n  ' + runtime.missing.join('\n  '));
      }
      return;
    }
    this._clearRestartTimer();
    const cfg = this._resolvedConfig();
    console.log(`[Computer] Sidecar uth raha hai (${why})`);
    this._spawn(cfg, this._fingerprint(cfg));
  }

  /**
   * Process mar gaya — kab aur kaise wapas laana hai.
   *
   * Hum ne khud maara (stop timeout, watchdog, config badli…) to foran; wo
   * khud mara (crash, load fail) to backoff ke saath, aur lagatar 5 dafa
   * `ready` tak na pohnche to haar. `ready` tak pohnch kar mara ho (task ke
   * beech crash) to ginti nahi — wo start ka masla nahi tha.
   */
  _scheduleRestart(killedBy, reachedReady, reason) {
    if (this._shuttingDown || killedBy === 'app quit' || this.child || this._restartTimer) return;
    const deliberate = Boolean(killedBy);
    if (!reachedReady && !deliberate) this._failures += 1;
    else if (reachedReady) this._failures = 0;
    else if (killedBy === 'load stalled' || killedBy === 'load timeout') this._failures += 1;

    if (this._failures >= MAX_START_FAILURES) {
      this.state = 'error';
      this.error = `computer agent failed to start ${this._failures} times (${reason})`;
      console.error(`[Computer] ${this.error} — supervisor ruk gaya. Agla task ya nayi config dobara koshish karwayegi.`);
      // Task qatar mein ho to usay ab latkaye rakhne ka koi matlab nahi.
      if (this.current && !this.current.dispatchedAt) {
        this._finishNotStarted(this.current.id, { status: 'error', summary: `Computer agent could not start: ${reason}. Please try again.`, error: reason });
      }
      return;
    }
    // Hum ne maara = foran wapas (1 s). Wo khud mara = backoff.
    const step = RESTART_BACKOFF_STEPS[Math.max(0, Math.min(this._failures, RESTART_BACKOFF_STEPS.length) - 1)];
    const delay = deliberate ? Math.min(RESTART_BACKOFF_MS, 1000) : Math.min(RESTART_MAX_MS, RESTART_BACKOFF_MS * step);
    console.log(`[Computer] Supervisor: sidecar ${delay} ms mein dobara (${killedBy || reason}, failures=${this._failures})`);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this._ensureProcess('restart');
    }, delay);
    this._restartTimer.unref?.();
  }

  _clearRestartTimer() {
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
  }

  // ── Sidecar ka process ───────────────────────────────────────────────────

  _fingerprint(cfg) {
    return crypto.createHash('sha1').update(JSON.stringify(cfg)).digest('hex');
  }

  _spawn(cfg, fp) {
    const python = resolvePython();
    const runner = resolveRunnerScript();
    const tesseract = resolveTesseract();
    const path = require('path');

    this.state = 'starting';
    this.error = null;
    this._spawnedWith = fp;
    this._loadingSince = Date.now();
    this._loadingFor = 0;
    console.log(`[Computer] Sidecar: ${python} (planner=${cfg.plannerModel}, grounding=${cfg.groundingModel}, ocr=${tesseract ? 'yes' : 'no'})`);

    const env = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      STONIC_COMPUTER_API_URL: cfg.apiUrl,
      STONIC_COMPUTER_API_KEY: cfg.apiKey,
      STONIC_COMPUTER_ROUTE: cfg.route || 'cloud',
      STONIC_COMPUTER_PLANNER_MODEL: cfg.plannerModel,
      STONIC_COMPUTER_GROUNDING_MODEL: cfg.groundingModel,
      // '0' = "khud hisaab karo". Yahan khali string nahi bheji ja sakti:
      // Windows par khali env var kabhi pohanchti hi nahi, aur phir `process.env`
      // ki purani qeemat (dev ki .env) chupke se child tak chali jati hai.
      STONIC_COMPUTER_GROUNDING_WIDTH: String(cfg.groundingWidth || '0'),
      STONIC_COMPUTER_GROUNDING_HEIGHT: String(cfg.groundingHeight || '0'),
      ...(tesseract ? { STONIC_COMPUTER_TESSERACT: tesseract } : {}),
    };

    // `-u` jaan bujh kar nahi diya: uska kaam PYTHONUNBUFFERED=1 (upar env
    // mein) bilkul wohi karta hai, aur bina flag ke ye spawn kisi bhi
    // interpreter ke saath chalta hai — jo test mein naqli sidecar chalane ke
    // liye zaroori hai (computer-manager.test.js).
    const child = spawn(python, [runner], {
      cwd: path.dirname(runner),
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.__knockdeskReady = false;

    readline.createInterface({ input: child.stdout }).on('line', (line) => this._onLine(child, line));
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      if (line.trim()) console.log('[Computer/py]', line);
    });

    // Pipe tootne par (EPIPE — process ja chuka, hum abhi likh rahe hain) Node
    // stream par `error` bhejta hai. Bina sunne wale ke wo uncaught exception
    // ban jata hai aur main process le doobta hai. Yahan sunna hi kaafi hai:
    // asal khabar `exit` handler se aati hai.
    child.stdin.on('error', (err) => {
      console.warn('[Computer] Sidecar ki stdin band ho gayi:', err.message);
    });

    // Handlers apna hi child yaad rakhte hain. Ye zaroori hai: ek marte hue
    // process ka `exit` us waqt bhi aa sakta hai jab uski jagah naya process
    // uth chuka ho, aur bina is pehchan ke wo purana event naye process ki
    // halat mita deta (state 'idle', child null) — halanke naya bilkul theek
    // chal raha hota.
    child.on('error', (err) => this._onExit(child, null, err));
    child.on('exit', (code, signal) => this._onExit(child, code, null, signal));

    this._armLoadTimers();
  }

  /** Load ki dhadkan ka pehra + kul hadd. */
  _armLoadTimers() {
    this._armLoadStall();
    if (this._loadCapTimer) clearTimeout(this._loadCapTimer);
    this._loadCapTimer = setTimeout(() => {
      this._loadCapTimer = null;
      if (this.child && this.state === 'starting') {
        console.error(`[Computer] Agent ${Math.round(LOAD_HARD_CAP_MS / 60000)} minute mein load nahi hua — process badal rahe hain.`);
        this._killChild('load timeout');
      }
    }, LOAD_HARD_CAP_MS);
    this._loadCapTimer.unref?.();
  }

  _armLoadStall() {
    if (this._loadStallTimer) clearTimeout(this._loadStallTimer);
    this._loadStallTimer = setTimeout(() => {
      this._loadStallTimer = null;
      if (this.child && this.state === 'starting') {
        console.error(`[Computer] Sidecar load ke dauran ${LOAD_STALL_MS / 1000}s se khamosh — hang samajh kar badal rahe hain.`);
        this._killChild('load stalled');
      }
    }, LOAD_STALL_MS);
    this._loadStallTimer.unref?.();
  }

  _clearLoadTimers() {
    if (this._loadStallTimer) { clearTimeout(this._loadStallTimer); this._loadStallTimer = null; }
    if (this._loadCapTimer) { clearTimeout(this._loadCapTimer); this._loadCapTimer = null; }
  }

  /**
   * Sidecar ko ek paigham. Kabhi throw nahi karta.
   *
   * `writable` kaafi nahi hai: process abhi abhi mara ho to stream apne aap ko
   * likhne ke qabil samajhta rehta hai aur write BAAD mein EPIPE deti hai. Wo
   * ghalti stream ke `error` event par aati hai — jise koi sun na raha ho to
   * Node use uncaught exception bana deta hai, yani poora main process gir
   * sakta hai. Ek band hote hue sidecar ki wajah se app ka girna qubool nahi.
   */
  _send(msg) {
    const child = this.child;
    if (!child || !child.stdin || !child.stdin.writable) return false;
    try {
      child.stdin.write(JSON.stringify(msg) + '\n');
      return true;
    } catch (err) {
      console.warn('[Computer] Sidecar ko paigham nahi bheja ja saka:', err.message);
      return false;
    }
  }

  _onLine(child, line) {
    if (child !== this.child) return;   // purane process ki aakhri saansein
    let ev;
    try { ev = JSON.parse(line); } catch { console.log('[Computer/py]', line); return; }

    switch (ev.event) {
      case 'booting':
        this.screen = ev.screen || this.screen;
        this._armLoadStall();
        break;
      case 'loading':
        // Zinda hai, agent load kar raha hai. Task qatar mein ho to HUD ko
        // seconds dikhao (task_starting) — ruki hui ghari "atak gaya" lagti hai.
        this._loadingFor = Number(ev.elapsed) || 0;
        this._armLoadStall();
        if (this.current && !this.current.dispatchedAt) {
          this._broadcast({ event: 'task_starting', id: this.current.id, elapsed: this._loadingFor, stage: ev.stage || 'loading agent' });
        }
        this._broadcast({ event: 'agent_state', state: 'loading', loadingFor: this._loadingFor });
        return;
      case 'ready': {
        const secs = ev.seconds != null ? ` (${ev.seconds}s mein)` : '';
        console.log(`[Computer] Agent tayyar${secs} — task foran shuru hoga.`);
        this.state = 'ready';
        this.error = null;
        this.screen = ev.screen || this.screen;
        child.__knockdeskReady = true;
        this._failures = 0;
        this._clearLoadTimers();
        this._broadcast({ event: 'agent_state', state: 'ready' });
        // Koi task intezaar mein hai? Abhi bhejo.
        if (this.current && !this.current.dispatchedAt && this.current.status === 'starting') this._dispatch();
        return;
      }
      case 'load_error':
        console.error('[Computer] Agent load fail:', ev.message);
        this.error = ev.message || 'agent load failed';
        // Process ab exit 2 karega — _onExit supervisor ko chalata hai.
        break;
      case 'warm':
        break;
      case 'task_started':
        if (this.current && this.current.id === ev.id) {
          this.current.status = 'running';
          this._clearStartTimer();
        }
        break;
      case 'task_starting':
        // Sidecar zinda hai, task se pehle kuch intezaar hai (pichhle stop ka
        // thread mouse chhor raha ho) — start-timer aage, START_HARD_CAP tak.
        if (this.current && this.current.id === ev.id && this.current.status === 'starting' && this.current.dispatchedAt) {
          const since = Date.now() - this.current.dispatchedAt;
          if (since < START_HARD_CAP_MS) this._armStartTimer(ev.id);
        }
        break;
      case 'step':
        if (this.current && this.current.id === ev.id) {
          this.current.step = ev.step;
          this.current.status = 'running';
          this.current.thought = ev.thought;
        }
        break;
      case 'task_done':
        this._finish(ev);
        break;
      case 'error':
        console.warn('[Computer] sidecar error:', ev.message, ev.id || '');
        if (ev.id && this.current && this.current.id === ev.id) {
          if (ev.message === 'busy') {
            // Sidecar apne hisaab se abhi pichhla task chala raha hai, hamare
            // hisaab se nahi — do halatein alag ho gayin. Process badal kar
            // wohi task dobara (_onExit → _retryOrFinish).
            this._killChild('busy');
          } else {
            // "task is empty" waghaira — hamari taraf se reserve tha; azad karo.
            this._finish({ id: ev.id, status: 'error', steps: 0, summary: `Computer agent error: ${ev.message}`, error: ev.message, notes: [] });
          }
        }
        break;
      default:
        break;
    }
    this._broadcast(ev);
  }

  _finish(result) {
    const id = result.id;
    if (this.current && this.current.id === id) {
      result.task = this.current.task;
      result.source = this.current.source;
      result.startedAt = this.current.startedAt;
      this.current = null;
      this._currentOwner = null;
    }
    result.finishedAt = Date.now();
    this.results.set(id, result);
    while (this.results.size > RESULT_HISTORY) this.results.delete(this.results.keys().next().value);
    if (this._stopTimer) { clearTimeout(this._stopTimer); this._stopTimer = null; }
    this._clearWatchdog();
    this._clearStartTimer();
    this._clearPendingTimer();
    this._unregisterShortcut();
    // Task ke dauran credentials badle the — ab process naye par utha lo.
    if (this._restartAfterTask && this.child && !this._shuttingDown) {
      this._restartAfterTask = false;
      this._killChild('config changed');
    }
    // Process kisi wajah se nahi hai aur supervisor ne waqfa nahi rakha? Uthao.
    if (!this.child && !this._restartTimer && !this._shuttingDown) this._startLater('after task');
    const set = this.waiters.get(id);
    if (set) { this.waiters.delete(id); set.forEach((resolve) => resolve(result)); }
  }

  _onExit(child, code, err, signal) {
    const reason = err ? err.message : `exit ${code}${signal ? ` (${signal})` : ''}`;
    console.log('[Computer] Sidecar band:', reason);
    const mine = this.child === child;
    const killedBy = child.__knockdeskKillReason || null;
    const reachedReady = Boolean(child.__knockdeskReady);

    // Halat sirf tab badlo jab ye WAHI process ho jo abhi hamara hai. Agar
    // ise pehle hi detach kiya ja chuka hai (`_killChild`), to `this.child`
    // ya to null hai ya naya process — dono soorat mein use chherna ghalat hai.
    if (mine) {
      this.child = null;
      this.state = err ? 'error' : 'idle';
      if (err) this.error = err.message;
      this._clearLoadTimers();
    }

    // Supervisor pehle — taake task ki retry ko pata ho ke naya process aa raha hai.
    if (mine || killedBy) this._scheduleRestart(killedBy, reachedReady, reason);

    if (this.current && this._currentOwner === child) {
      // Chalta hua task ISI process ke paas tha.
      const steps = this.current.step || 0;
      // Task ke beech mein mara — sidecar apna cursor cleanup nahi kar saka.
      this._restoreCursorBackstop(killedBy || reason);
      if (START_FAILURES.has(killedBy)) {
        // Task shuru hi nahi hua tha — ye maut nahi, dobara koshish hai.
        this._retryOrFinish(killedBy);
      } else {
        const outcome = killedBy === 'stop timeout' || killedBy === 'app quit'
          ? { status: 'stopped', summary: `Task stopped after ${steps} steps.`, error: null }
          : killedBy === 'watchdog'
            ? {
              status: 'error',
              summary: `Task ran past its ${TASK_WATCHDOG_MS / 60000}-minute limit after ${steps} steps and was stopped. It may be stuck on a screen it cannot get past.`,
              error: 'watchdog timeout',
            }
            : {
              status: 'error',
              summary: `Computer agent process died (${reason}) after ${steps} steps.`,
              error: reason,
            };
        this._finish({ id: this.current.id, steps, notes: [], ...outcome });
      }
    } else if (this.current && !this.current.dispatchedAt && mine && killedBy === 'app quit') {
      this._finishNotStarted(this.current.id, { status: 'stopped', summary: 'Task stopped before it started.', error: null });
    }
    // `process_exit` sirf tab jab koi task baqi na ho. Task qatar mein ho
    // (agent load ho raha tha, ya retry) to HUD 'starting' par hi rahe —
    // supervisor naya process laayega aur `ready` par task khud chal parega.
    if (!this.current) this._broadcast({ event: 'process_exit', reason });
  }

  /**
   * Sidecar band karo — aur usay USI LAMHE detach kar do.
   *
   * Detach synchronous hona zaroori hai. `kill()` ke baad `exit` event agle
   * tick se pehle nahi aata, aur us darmiyani lamhe mein koi aur raasta
   * `this.child` ko zinda samajh kar `_send()` kar sakta hai — ek aise process
   * ko jo mar chuka hai. Yahan haath ke haath null kar dena us raaste ko band
   * kar deta hai.
   */
  _killChild(why) {
    const child = this.child;
    if (!child) return;
    console.log('[Computer] Sidecar ko band kar rahe hain:', why);
    child.__knockdeskKillReason = why;
    this.child = null;
    this.state = 'idle';
    this._clearLoadTimers();
    try { child.stdin.end(); } catch { /* */ }
    try { child.kill(); } catch { /* */ }
    // Aur uska poora tree bhi. `child.kill()` sirf trampoline ko maarta hai —
    // asli Python (mouse/keyboard wala) uska child hai aur bach jata hai.
    // App quit par ye sync hona chahiye, warna app pehle nikal jati hai.
    if (typeof killProcessTree === 'function') killProcessTree(child.pid, { sync: why === 'app quit' });
  }

  // ── Task ka hawala: bhejo, shuru hone ka pehra, ek retry ────────────────

  /**
   * `current` task sidecar ko bhejo aur "shuru hua?" ka pehra lagao.
   *
   * Likhai ka jawab dekha jata hai — `_send()` ka false phenk diya jaye to
   * task kabhi shuru na ho magar `current` bhara rahe.
   */
  _dispatch() {
    const t = this.current;
    if (!t || !this.child) return;
    // Kaunse process ke paas ye task hai — `current` ke andar nahi, kyunki wo
    // object IPC par renderer tak jata hai aur ChildProcess serialize nahi hota.
    this._currentOwner = this.child;
    t.dispatchedAt = Date.now();
    this._clearPendingTimer();
    const sent = this._send({ cmd: 'run', id: t.id, task: t.task, max_steps: t.maxSteps, fast: t.fast, overlay: t.overlay });
    if (!sent) {
      // Process hai magar likha nahi ja saka = mar raha hai. Usay band kar do;
      // uska exit hamein retry par le jayega.
      this._killChild('not delivered');
      return;
    }
    this._armStartTimer(t.id);
  }

  _armStartTimer(taskId) {
    this._clearStartTimer();
    this._startTimer = setTimeout(() => {
      this._startTimer = null;
      const t = this.current;
      if (!t || t.id !== taskId || t.status !== 'starting') return;
      console.error(`[Computer] Task ${taskId} ${START_TIMEOUT_MS / 1000}s mein shuru nahi hua — sidecar badal kar dobara.`);
      if (this.child) this._killChild('start timeout');
      else this._retryOrFinish('start timeout');
    }, START_TIMEOUT_MS);
    this._startTimer.unref?.();
  }

  _clearStartTimer() {
    if (this._startTimer) { clearTimeout(this._startTimer); this._startTimer = null; }
  }

  _armPendingTimer(taskId) {
    this._clearPendingTimer();
    this._pendingTimer = setTimeout(() => {
      this._pendingTimer = null;
      const t = this.current;
      if (!t || t.id !== taskId || t.dispatchedAt) return;
      console.error(`[Computer] Task ${taskId}: agent ${Math.round(PENDING_MAX_MS / 60000)} minute mein tayyar nahi hua — task naakaam.`);
      this._finishNotStarted(taskId, {
        status: 'error',
        summary: `Computer agent is still loading after ${Math.round(PENDING_MAX_MS / 60000)} minutes. Please try again shortly.`,
        error: 'agent not ready',
      });
    }, PENDING_MAX_MS);
    this._pendingTimer.unref?.();
  }

  _clearPendingTimer() {
    if (this._pendingTimer) { clearTimeout(this._pendingTimer); this._pendingTimer = null; }
  }

  /**
   * Sidecar ne task uthaya hi nahi (`why`: start timeout / busy / not delivered).
   *
   * Ek dafa naye process par WOHI task, wohi id — taake `waitFor(id)` wale
   * (voice, Hermes) ko kuch badla na lage. Supervisor process laata hai,
   * `ready` par task khud chal parta hai. Doosri dafa bhi na chale to saaf
   * error abhi, 22-minute ke watchdog ka intezaar nahi.
   */
  _retryOrFinish(why) {
    const t = this.current;
    if (!t) return;
    this._clearStartTimer();
    if (t.status === 'stopping') {
      this._finishNotStarted(t.id, { status: 'stopped', summary: 'Task stopped before it started.', error: null });
      return;
    }
    if (!t.retried) {
      t.retried = true;
      t.dispatchedAt = null;
      t.status = 'starting';
      this._currentOwner = null;
      console.warn(`[Computer] Task ${t.id} shuru nahi hua (${why}) — naya sidecar, ek aur koshish.`);
      this._armPendingTimer(t.id);
      if (this.child && this.state === 'ready') this._dispatch();
      else this._ensureProcess('retry');
      return;
    }
    console.error(`[Computer] Task ${t.id} dobara bhi shuru nahi hua (${why}) — naakaam.`);
    this._finishNotStarted(t.id, {
      status: 'error',
      summary: `Computer agent did not start (${why}). Please try again.`,
      error: why,
    });
  }

  /** Task jo kabhi shuru nahi hua — natija likho aur HUD/renderer ko `task_done` do. */
  _finishNotStarted(taskId, outcome) {
    const result = { id: taskId, steps: 0, seconds: 0, notes: [], ...outcome };
    this._finish(result);
    this._broadcast({ event: 'task_done', ...result });
  }

  // ── Watchdog / shortcut / broadcast ─────────────────────────────────────

  _armWatchdog(taskId) {
    this._clearWatchdog();
    this._watchdog = setTimeout(() => {
      this._watchdog = null;
      if (!this.current || this.current.id !== taskId) return;
      console.error(`[Computer] Task ${taskId} ${TASK_WATCHDOG_MS / 60000} minute se chal raha hai — zabardasti band.`);
      // Narmi ki koshish nahi: watchdog ka matlab hi ye hai ke narmi kaam nahi
      // kar rahi. Process maarna hi wo ek cheez hai jo hamesha chalti hai.
      if (this.child) this._killChild('watchdog');
      else this._finishNotStarted(taskId, { status: 'error', summary: 'Task timed out before the agent could start.', error: 'watchdog timeout' });
    }, TASK_WATCHDOG_MS);
    this._watchdog.unref?.();
  }

  _clearWatchdog() {
    if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
  }

  _registerShortcut() {
    if (this._shortcutOn) return;
    try {
      this._shortcutOn = globalShortcut.register(EMERGENCY_SHORTCUT, () => {
        console.log('[Computer] Emergency stop (shortcut).');
        this.stop();
      });
    } catch (err) {
      console.warn('[Computer] Shortcut register nahi hua:', err.message);
    }
  }

  _unregisterShortcut() {
    if (!this._shortcutOn) return;
    try { globalShortcut.unregister(EMERGENCY_SHORTCUT); } catch { /* */ }
    this._shortcutOn = false;
  }

  _broadcast(ev) {
    // Screen overlay pehle — wo user ko sab se pehle nazar aata hai.
    if (this._overlay) {
      try { this._overlay.event(ev); } catch (err) { console.warn('[Computer] Overlay event fail:', err.message); }
    }
    const win = this.mainWindow;
    if (!win || win.isDestroyed()) return;
    try { win.webContents.send('computer:event', ev); } catch { /* window ja chuki */ }
  }

  /** App band ho rahi hai — supervisor ruk jaye, process tree sync mare. */
  shutdown() {
    this._shuttingDown = true;
    this._clearBootTimer();
    this._clearRestartTimer();
    this._clearLoadTimers();
    this._clearWatchdog();
    this._clearStartTimer();
    this._clearPendingTimer();
    if (this._stopTimer) { clearTimeout(this._stopTimer); this._stopTimer = null; }
    this._unregisterShortcut();
    if (this.child) {
      // Task chal raha ho to sidecar ka `os._exit` cursor wapas nahi karega —
      // aur app ke jaane ke baad `exit` handler ka bharosa nahi. Abhi karo.
      if (this.current) this._restoreCursorBackstop('app quit');
      this._send({ cmd: 'shutdown' });
      this._killChild('app quit');
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

module.exports = { ComputerManager, EMERGENCY_SHORTCUT };
