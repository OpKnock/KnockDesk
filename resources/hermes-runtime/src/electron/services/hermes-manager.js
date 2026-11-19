// HermesManager — runs the UNMODIFIED Hermes Agent dashboard as a separate
// local process and gives KnockDesk a narrow, read-mostly bridge to it.
//
// Hard rule (see user directive): the Hermes install is never patched or
// reconfigured from here. We only (1) spawn the same `hermes dashboard
// --no-open` command the user runs by hand, (2) probe its public
// /api/status endpoint, and (3) forward REST calls with the session token
// the dashboard itself injects into its index.html.
//
// If a dashboard is already running on the port (user started it manually),
// we adopt it instead of spawning a second one and we never kill it on exit.

const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const { resolveHermesExe, hermesSpawnEnv } = require('./hermes-runtime');
const {
  ensureKnockDeskPlugin,
  ensureKnockDeskComputerPlugin,
  ensureKnockDeskMemoryPlugin,
  MEMORY_PLUGIN_NAME,
} = require('./knockdesk-plugin');
const childRegistry = require('./child-registry');

const DEFAULT_PORT = parseInt(process.env.STONIC_HERMES_PORT || '9119', 10);
// First boot can rebuild the dashboard web bundle (npm build inside Hermes),
// which takes minutes on slow disks. Poll generously.
const READY_TIMEOUT_MS = 4 * 60 * 1000;
const READY_POLL_MS = 1500;
const STATUS_REFRESH_MS = 15000;
// Quit is not the place to wait out a slow gateway shutdown; main.js' sync sweep
// kills whatever is still standing after this.
const GATEWAY_STOP_TIMEOUT_MS = 4000;
// Recording owned processes costs a full process scan, so the status loop is
// rate-limited to this. Gateway start and shutdown bypass it.
const OWNED_SCAN_MIN_INTERVAL_MS = 60 * 1000;
// Credential badalne par hone wale do AUTOMATIC restarts ke darmiyan kam se kam
// itna waqfa. Gateway ko stop-o-start mein ~20 second lagte hain, is liye is se
// tez bounce usay hamesha ke liye be-kaar kar dete hain — wo kabhi kisi turn ko
// poora nahi kar pata. 60 second us se aaram se upar hai aur user ke apne save
// kiye huay key ke liye bhi intezaar mehsoos nahi hota (bounce qatar mein jata
// hai, gir-ta nahi).
const CREDENTIAL_RESTART_MIN_GAP_MS = 60 * 1000;
// How long an agent turn may go with NO activity at all before Hermes cuts it
// loose — see _ensureGatewayTimeout(). Hermes' own default is the value we only
// overwrite when we find it unchanged.
const HERMES_DEFAULT_GATEWAY_TIMEOUT = 1800;
const STUCK_TURN_TIMEOUT_S = 600;
const STUCK_TURN_WARNING_S = 300;
// ── Mobile Remote ka setup: kitni koshishein, kitne waqfe se ─────────────────
//
// Ye retry ek asli bug ka ilaaj hai, ehtiyat nahi. Pehle ye setup sirf EK dafa
// chalta tha — us lamhe jab renderer ka Supabase channel jurta hai — aur agar
// us waqt Hermes abhi uth raha hota to chup-chaap `{ok:false}` de kar khatam ho
// jata. Packaged app mein wo hamesha hota tha: channel 1-3 second mein jur jata
// hai, jabke bundled Python ko tayyar hone mein 30 second se kai minute lagte
// hain. Nateeja — gateway kabhi start hi na hota, plugin kabhi na jurta, aur
// phone par hamesha "Desktop offline". Dev mein masla nazar nahi aata tha
// kyunki wahan Hermes pehle se chal raha hota hai (adopt ho jata hai) aur
// renderer ka har reload is setup ko dobara chala deta hai.
//
// Waqfe: 2s, 4s, 8s, 16s, 32s, 60s, 60s… — kul milakar ~6 minute tak koshish,
// jo `READY_TIMEOUT_MS` (4 minute) se aaram se upar hai.
const KNOCKDESK_SETUP_RETRY_MIN_MS = 2_000;
const KNOCKDESK_SETUP_RETRY_MAX_MS = 60_000;
const KNOCKDESK_SETUP_MAX_ATTEMPTS = 10;
// ── Gateway ki nigrani (supervisor) ──────────────────────────────────────────
//
// Gateway ko ek dafa chala kar bhool jana kaafi nahi. Wo dashboard ka bhai hai,
// beta nahi — is liye wo AKELA bhi mar sakta hai (crash, antivirus, kisi aur
// process ka sweep) jabke dashboard, aur us ke saath `state === 'ready'`,
// bilkul theek rehta hai. Us surat mein phone app restart tak "offline" rehta
// tha: gateway ko dekhne wala koi tha hi nahi.
//
//   DOWN_CONFIRM_TICKS : itni musalsal dharkanon (har ek STATUS_REFRESH_MS) par
//                        band mile tab hi maana jata hai — ek akeli dharkan
//                        kisi restart ke beech bhi gir sakti hai
//   COMMAND_GRACE      : start/restart bhejne ke baad gateway ko uthne ka waqt
//   HOLD_MAX           : jaan bujh kar roka gaya gateway (WhatsApp pairing us
//                        se session folder leti hai) zyada se zyada itni der
//                        chhora jata hai; pairing ki apni hadd 4 minute hai
//   REVIVE_MIN/MAX_GAP : baar baar girne par waqfa dugna hota jata hai, taake
//                        ek toota hua gateway poori machine ko na thakaye
//   STABLE             : itni der musalsal chalne par girne ki ginti saaf
const GATEWAY_DOWN_CONFIRM_TICKS = 2;
const GATEWAY_COMMAND_GRACE_MS = 45 * 1000;
const GATEWAY_HOLD_MAX_MS = 6 * 60 * 1000;
const GATEWAY_REVIVE_MIN_GAP_MS = 30 * 1000;
const GATEWAY_REVIVE_MAX_GAP_MS = 10 * 60 * 1000;
const GATEWAY_STABLE_MS = 5 * 60 * 1000;
// Hermes' api_server platform — the OpenAI-compatible HTTP surface that also
// carries its asynchronous run API (/v1/runs). Agent Town drives its seats
// through it; see agent-town-main/lib/hermes-run-api.ts.
const RUN_API_PORT = parseInt(process.env.STONIC_HERMES_API_PORT || '8642', 10);

class HermesManager {
  constructor() {
    this.port = DEFAULT_PORT;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this.child = null;
    this.external = false;        // true when we adopted a dashboard we did not spawn
    this.state = 'idle';          // idle | starting | ready | error | stopped
    this.error = null;
    this.token = null;
    this.lastStatus = null;       // last /api/status payload
    this.exePath = null;
    this.mainWindow = null;
    this._readyPoller = null;
    this._statusTimer = null;
    this._stopping = false;
    this._autoRestarts = 0;   // crash-loop guard for spawned children
    // Gateway + WhatsApp bridge are siblings, not children — see child-registry.
    // The snapshot is every such process that existed BEFORE we did anything,
    // so whatever appears later is ours to clean up and the user's own Hermes
    // never is.
    this._preexistingHermes = [];
    this._gatewayStartedByUs = false;
    this._approvalBypassApplied = false;
    this._sttProviderApplied = false;
    this._gatewayTimeoutApplied = false;
    this._skillsDirApplied = false;
    // Memory Core ka provider (`knockdesk-memory`). Tafseel `_installMemoryPlugin`
    // aur `_ensureMemoryProvider` par.
    //   _memoryProviderApplied : `memory.provider` dekha/likha ja chuka
    //   _memoryPluginUpdated   : plugin ka Python code BADLA hai aur gateway ko
    //                            abhi tak naya code uthane ka mauqa nahi mila
    this._memoryProviderApplied = false;
    this._memoryPluginUpdated = false;
    // { url, key } for Hermes' run API once api_server is configured.
    this.runApi = null;
    this._runApiPromise = null;
    this._runApiVerifiedAt = 0;
    this._runApiFailedAt = 0;
    // Mobile Remote (KnockDesk platform plugin) ka setup — ek waqt mein ek koshish.
    this._knockdeskReady = null;
    this._knockdeskReady = false;
    // Jo setup HONA chahiye — `{ bridgeUrl, bridgeKey, chatId }`.
    //
    // Ye "yaad" hi is poore feature ki jaan hai. Setup ki darkhwast us waqt aa
    // jati hai jab Hermes abhi uth raha hota hai; usay us lamhe rad kar dena
    // ghalat tha. Ab darkhwast yahan mehfooz rehti hai aur Hermes ke tayyar
    // hote hi khud chal jati hai — kisi ko dobara poochna nahi parta.
    this._knockdeskWanted = null;
    this._knockdeskPending = false;
    this._knockdeskAttempts = 0;
    this._knockdeskRetryTimer = null;
    this._knockdeskLastError = null;
    // Gateway ki nigrani — tafseel `_superviseGateway` par.
    this._gatewayDownTicks = 0;      // musalsal kitni dharkanon se band hai
    this._gatewayUpSince = 0;        // kab se musalsal chal raha hai
    this._gatewayRevivals = 0;       // bina sukoon ke kitni dafa uthaya gaya
    this._gatewayLastReviveAt = 0;
    this._gatewayCommandAt = 0;      // aakhri start/restart kab bheja gaya
    this._gatewayHeldAt = 0;         // kab jaan bujh kar roka gaya (0 = nahi)
    // Har env key mein hum ne AAKHRI dafa kya likha. Sirf is process ki yaad
    // hai, disk par kuch nahi — aur usay disk par rakhna ghalat bhi hoga:
    // Hermes ki .env bahar se bhi badal sakti hai, aur ek purani "yaad" us
    // surat mein asli likhayi rok deti. Khali yaad ka matlab "pata nahi" hai,
    // aur uska jawab hamesha "likh do" hota hai — yani mehfooz taraf.
    //
    // Ye kis kaam ki hai: env ki har likhayi gateway ka restart hai. Wahi
    // value dobara likhna ek be-wajah restart hai, aur wo agar baar baar ho to
    // gateway kabhi kaam ke qabil nahi rehta. Tafseel `envValueChanged` par.
    this._envWritten = new Map();
    // Credential badalne par hone wale AUTOMATIC restart ka aakhri waqt, aur
    // wo restart jo abhi qatar mein hai. Tafseel `restartGatewayForCredentialChange`.
    this._lastCredentialRestartAt = 0;
    this._credentialRestartTimer = null;
  }

  // ── Env ki yaad ───────────────────────────────────────────────────────────
  //
  // Ye do chhote function poori app ka wahid pehra hain jo "be-wajah gateway
  // restart" rok-ta hai. Renderer ki har env likhayi `hermes:api` se guzarti
  // hai, aur wo yahin poochta hai: value waqai badli hai?
  //
  // Khali yaad = "pata nahi" = likh do. Ye jaan bujh kar hai: app khulte hi
  // pehli likhayi hamesha jati hai (chahe .env mein wohi value pari ho), aur
  // us ki qeemat ek hi restart hai. Ulta faisla — "shayad wohi hogi, chhor do"
  // — us surat mein khatarnak hai jab .env waqai khali ho: key kabhi likhi hi
  // na jati aur Hermes bina credentials ke chalta rehta.
  envValueChanged(key, value) {
    if (!this._envWritten.has(key)) return true;
    return this._envWritten.get(key) !== value;
  }

  /** Kaamyab likhayi ke BAAD — pehle nahi. `null` = key hata di gayi. */
  rememberEnvValue(key, value) {
    this._envWritten.set(key, value);
  }

  setWindow(win) { this.mainWindow = win; }

  // ── Read-only personalization bridge ─────────────────────────────────
  // Hermes' data home (Windows: %LOCALAPPDATA%\hermes, elsewhere ~/.hermes).
  // KnockDesk only ever READS the memory files here — it never creates, writes,
  // or locks anything inside this folder (see the hard rule at the top).
  getHermesHome() {
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      return path.join(localAppData, 'hermes');
    }
    return path.join(os.homedir(), '.hermes');
  }

  // Read Hermes' curated memory (MEMORY.md + USER.md) so the voice assistant
  // can inject it into its system prompt at session start — the same frozen
  // snapshot pattern Hermes itself uses. Files are UTF-8 with § delimiters;
  // reading them has zero effect on Hermes.
  readMemoryFiles() {
    const memoriesDir = path.join(this.getHermesHome(), 'memories');
    const readOne = (name) => {
      try {
        const p = path.join(memoriesDir, name);
        if (!fs.existsSync(p)) return '';
        return fs.readFileSync(p, 'utf8').trim();
      } catch (err) {
        console.warn(`[Hermes] Could not read ${name}:`, err.message);
        return '';
      }
    };
    const memory = readOne('MEMORY.md');
    const user = readOne('USER.md');
    return {
      available: Boolean(memory || user),
      memory,
      user,
      home: this.getHermesHome(),
    };
  }

  // ── Write path: hand a fact to Hermes so HERMES decides and writes ──
  // KnockDesk never touches Hermes' memory files. A fact is delivered as a
  // one-shot agent run (`hermes -z "<prompt>"`): Hermes' own agent evaluates
  // it against its save/skip policy and, if worth keeping, stores it via its
  // own memory tool — so char limits, security scanning, dedup and (if
  // enabled) write approval all stay enforced. Facts are queued and run one
  // at a time; results are logged and broadcast, never awaited by the voice
  // turn.
  shareFact(fact, person) {
    const cleanFact = String(fact || '').trim().slice(0, 600);
    if (!cleanFact) return { ok: false, error: 'Empty fact' };
    if (!this._shareQueue) this._shareQueue = [];
    this._shareQueue.push({ fact: cleanFact, person: String(person || '').trim().slice(0, 80) });
    this._drainShareQueue();
    return { ok: true, queued: true, pending: this._shareQueue.length };
  }

  _drainShareQueue() {
    if (this._shareBusy || !this._shareQueue || this._shareQueue.length === 0) return;
    this._shareBusy = true;
    const { fact, person } = this._shareQueue.shift();

    // Light touch, same as memoryRequest: relay the fact and let Hermes apply
    // its own memory policy. The only thing Hermes can't infer is WHO the fact
    // is about when it's not the owner, so we pass that as plain context — not
    // as an instruction on how to store it.
    const context = person
      ? `The user mentioned something about ${person} (not the owner): "${fact}".`
      : `The user mentioned: "${fact}".`;
    const prompt =
      `[Memory note via KnockDesk voice assistant] ${context} ` +
      "Please save it to their memory if it's worth keeping.";

    const exe = this.resolveExe();
    console.log('[Hermes] Memory hand-off via oneshot:', fact.slice(0, 120));
    let child;
    try {
      child = spawn(exe, ['-z', prompt], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: os.homedir(),
        env: hermesSpawnEnv(),
      });
    } catch (err) {
      this._finishShare(fact, false, `spawn failed: ${err.message}`);
      return;
    }

    let out = '';
    let settled = false;
    const settle = (ok, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this._finishShare(fact, ok, message);
    };
    // First runs can be slow (venv warm-up + model call) — allow 3 minutes.
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      settle(false, 'timed out after 180s');
    }, 180000);

    child.stdout?.on('data', (buf) => { out += String(buf); });
    child.stderr?.on('data', (buf) => { out += String(buf); });
    child.on('error', (err) => settle(false, `launch error: ${err.message} (is Hermes installed?)`));
    child.on('exit', (code) => {
      const summary = out.trim().split(/\r?\n/).filter(Boolean).pop() || '(no output)';
      settle(code === 0, code === 0 ? summary : `exit ${code}: ${summary.slice(0, 300)}`);
    });
  }

  // ── Interactive memory request (from the Memory modal) ──────────────
  // The user types a plain-language memory instruction ("add X", "fix the
  // entry that says Y", "forget Z"). We hand it to Hermes' OWN agent via a
  // one-shot; Hermes edits its memory with its own tool (limits, scanning,
  // dedup, approval gate all apply). Unlike shareFact this is AWAITED so the
  // modal can show the result and re-read the files. Never writes files here.
  async memoryRequest(instruction) {
    const clean = String(instruction || '').trim().slice(0, 1500);
    if (!clean) return { ok: false, error: 'Empty request' };

    // Light touch: just relay the user's request. Hermes already knows how to
    // manage its own memory (add/replace/remove, limits, curation) — we don't
    // instruct it, we only point that a memory request came in.
    const prompt =
      `[Memory request via KnockDesk app] The user said: "${clean}". ` +
      'Please save or update their memory accordingly.';

    const exe = this.resolveExe();
    console.log('[Hermes] Memory request via oneshot:', clean.slice(0, 120));

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(exe, ['-z', prompt], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: os.homedir(),
          env: hermesSpawnEnv(),
        });
      } catch (err) {
        return resolve({ ok: false, error: `Could not launch Hermes: ${err.message}` });
      }

      let out = '';
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        settle({ ok: false, error: 'Hermes took too long (over 180s) — try again.' });
      }, 180000);

      child.stdout?.on('data', (buf) => { out += String(buf); });
      child.stderr?.on('data', (buf) => { out += String(buf); });
      child.on('error', (err) => settle({ ok: false, error: `Hermes launch error: ${err.message} (is Hermes installed?)` }));
      child.on('exit', (code) => {
        const summary = out.trim().split(/\r?\n/).filter(Boolean).pop() || '(no response)';
        if (code === 0) {
          settle({ ok: true, message: summary });
        } else {
          settle({ ok: false, error: `Hermes exited (code ${code}): ${summary.slice(0, 300)}` });
        }
      });
    });
  }

  _finishShare(fact, ok, message) {
    console.log(`[Hermes] Memory hand-off ${ok ? 'done' : 'FAILED'}:`, message.slice(0, 300));
    try {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('hermes-share-result', { ok, fact, message });
      }
    } catch { /* window may be closing */ }
    this._shareBusy = false;
    // Keep draining queued facts sequentially.
    setTimeout(() => this._drainShareQueue(), 500);
  }

  // ── Public state consumed by the renderer ────────────────────────────
  getState() {
    return {
      state: String(this.state || ''),
      error: this.error ? String(this.error) : null,
      url: String(this.baseUrl || ''),
      port: Number(this.port || 0),
      external: Boolean(this.external),
      exePath: this.exePath ? String(this.exePath) : '',
      status: this.lastStatus && typeof this.lastStatus === 'object'
        ? { ...this.lastStatus }
        : null,
      knockdeskReady: Boolean(this._knockdeskReady),
      knockdeskPending: Boolean(this._knockdeskPending),
      knockdeskError: this._knockdeskLastError ? String(this._knockdeskLastError) : null,
    };
  }

  _setState(state, error = null) {
    const wasReady = this.state === 'ready';
    this.state = state;
    this.error = error;
    this._broadcast();

    // ── HERMES TAYYAR HOTE HI MOBILE REMOTE KHUD KHARA HO JAYE ───────────
    //
    // Yehi wo lamha hai jo pehle guzar jata tha. Setup ki darkhwast pehle hi
    // aa chuki hoti hai (bridge boot par, ya renderer ke jurte hi), magar us
    // waqt Hermes tayyar nahi tha. Ab wo darkhwast yaad rakhi jati hai aur
    // theek is guzargah par chalti hai — "tayyar nahi tha, ab tayyar hai".
    //
    // `!wasReady` ki shart lazmi hai: `_setState('ready')` status loop se bhi
    // chal sakti hai, aur har dafa setup dobara chalana gateway ka be-wajah
    // restart hai.
    if (state === 'ready' && !wasReady && this._knockdeskPending) {
      this._runKnockDeskSetupSoon(0);
    }

    // ── HERMES GIRA TO MOBILE REMOTE BHI GIR GAYA ────────────────────────
    //
    // Gateway dashboard ka bhai hai, beta nahi — magar dashboard mar jaye to
    // KnockDesk uska gateway bhi saaf kar deta hai. Yani restart ke baad plugin
    // kahin nahi chal raha hota, chahe .env aur config bilkul theek hon.
    //
    // Bina is ke `_knockdeskReady` purani (ab jhooti) haan par atka rehta aur
    // `requestKnockDeskPlatform` "ho chuka hai" keh kar wapas mur jata. Nateeja
    // theek wohi hota jo asal bug tha: gateway band, phone par offline, aur
    // kisi ko dobara koshish karne ka khayal hi nahi. Is liye halat ka girna
    // yaad ki safai bhi hai.
    if (wasReady && state !== 'ready' && !this._stopping) {
      this._knockdeskReady = false;
      if (this._knockdeskWanted && this._knockdeskWanted.chatId) {
        this._knockdeskPending = true;
        this._knockdeskAttempts = 0;
      }
    }
  }

  _broadcast() {
    try {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('hermes-state', this.getState());
      }
    } catch { /* window may be closing */ }
  }

  // ── Approval bypass that outlives our own spawns ─────────────────────
  // hermesSpawnEnv()'s HERMES_YOLO_MODE only reaches processes KnockDesk starts,
  // and two Hermes processes routinely escape that: a dashboard that was
  // already running when we booted (we adopt it rather than spawn one), and a
  // gateway Windows relaunches from its ONLOGON scheduled task. Both would go
  // back to blocking a turn on an approval nobody is watching for — the
  // WhatsApp path especially, where there is no UI to answer from.
  //
  // So once the dashboard answers, persist the same bypass as config. Hermes'
  // config cache is mtime-keyed, so this lands on the running processes too,
  // without a restart. PUT /api/config deep-merges server-side, so only these
  // four keys move and everything else the user has set survives.
  //
  // This writes user data (%LOCALAPPDATA%\hermes\config.yaml), the same place
  // _ensureKnockDeskThemes() writes — the Hermes install itself stays untouched.
  async _ensureApprovalBypass() {
    if (this._approvalBypassApplied) return;
    // The desktop shell keeps command approvals enabled by default. Only honor
    // the deliberately named advanced opt-in; never silently persist approvals
    // off because a dashboard happened to start.
    if (process.env.KNOCKDESK_ALLOW_UNAPPROVED_COMMANDS !== '1') {
      console.info('[Hermes] Leaving command approval settings unchanged (safe default).');
      return;
    }
    const res = await this.apiFetch('/api/config', {
      method: 'PUT',
      body: {
        config: {
          approvals: {
            mode: 'off',                      // the dangerous-command gate itself
            cron_mode: 'approve',             // cron runs with no user to ask
            destructive_slash_confirm: false, // /clear, /new, /reset, /undo
            mcp_reload_confirm: false,        // /reload-mcp
          },
        },
      },
    });
    if (res.ok) {
      this._approvalBypassApplied = true;
      console.log('[Hermes] Approval prompts disabled (approvals.mode=off).');
    } else {
      // Non-fatal: spawned processes already carry HERMES_YOLO_MODE, so this
      // only costs us the adopted-dashboard case. Retried on the next start().
      console.warn('[Hermes] Could not persist approval bypass:',
        res.status, (res.data && res.data.error) || '');
    }
  }

  // ── One skills folder, two consumers ──────────────────────────────────
  // KnockDesk's Skills panel writes to Documents/KnockDesk Data/skills/custom.
  // Hermes indexes its own skills dir and nothing else, so a skill the user
  // wrote was invisible to every agent — it only worked if they happened to go
  // through the voice assistant. A user who talks to an agent directly (the
  // common case) would watch their own skill be ignored.
  //
  // Hermes already handles exactly this: `skills.external_dirs` is a list of
  // extra folders it scans alongside its own. Pointing it at the folder the
  // user's skills are ALREADY in means nothing is moved and nothing is copied
  // — no existing skill changes location, the agents simply start seeing the
  // same files the voice side has always seen.
  //
  // Written through PUT /api/config so the running dashboard and gateway pick
  // it up from their mtime-keyed config cache without a restart.
  async _ensureSkillsExternalDir() {
    if (this._skillsDirApplied) return;

    let ourDir;
    try {
      // Lazily required: the ipc module reaches for app.getPath('documents'),
      // which is only meaningful once Electron is ready.
      const { getCustomSkillsDir } = require('../main/ipc/skills-handlers');
      // Forward slashes on purpose — a Windows path in double-quoted YAML would
      // read `\U` as an escape sequence. Python's Path takes either form.
      ourDir = getCustomSkillsDir().replace(/\\/g, '/');
    } catch (err) {
      console.warn('[Hermes] Could not resolve the KnockDesk skills folder:', err.message);
      return;
    }

    // Read before writing: _deep_merge replaces lists wholesale server-side, so
    // a blind write would silently drop any dir the user added themselves.
    const current = await this.apiFetch('/api/config/raw');
    if (!current.ok || !current.data || typeof current.data.yaml !== 'string') {
      console.warn('[Hermes] Could not read config to register the skills folder; will retry on next start.');
      return;
    }

    const existing = this._parseSkillsListKey(current.data.yaml, 'external_dirs');
    const already = existing.some((dir) => dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      === ourDir.replace(/\/+$/, '').toLowerCase());
    if (already) {
      this._skillsDirApplied = true;
      return;
    }

    const res = await this.apiFetch('/api/config', {
      method: 'PUT',
      body: { config: { skills: { external_dirs: [...existing, ourDir] } } },
    });
    if (res.ok) {
      this._skillsDirApplied = true;
      console.log('[Hermes] KnockDesk skills folder registered with the agents:', ourDir);
    } else {
      console.warn('[Hermes] Could not register the skills folder:',
        res.status, (res.data && res.data.error) || '');
    }
  }

  // Read one list-valued key out of the `skills:` section of raw config.yaml.
  //
  // Hand-rolled because the app ships no YAML parser and these two keys
  // (`external_dirs`, `disabled`) are the only ones we ever read back. Hermes
  // writes the file with yaml.safe_dump so the shape is predictable; the
  // flow-style branch covers a config someone hand-edited into `key: [a, b]`.
  _parseSkillsListKey(yamlText, key) {
    return this._parseConfigListKey(yamlText, 'skills', key);
  }

  // Wahi reader, magar kisi bhi top-level section ke liye. `plugins.enabled`
  // ko bilkul yehi chahiye tha, aur skills wala `skills:` par jama hua tha.
  // Ek parameter se ek hi soch-samajh kar likha parser do jagah kaam aa
  // jata hai — do alag parser rakhne se behtar, jo kisi din alag ho jate.
  _parseConfigListKey(yamlText, sectionName, key) {
    const unquote = (value) => value.trim().replace(/^['"]|['"]$/g, '');

    // Isolate the section's mapping — its indented body, up to the next
    // top-level key — so a same-named key under another section can't match.
    const section = yamlText.match(
      new RegExp(`^${sectionName}:[ \\t]*\\n((?:(?:[ \\t]+.*)?\\n)*)`, 'm'),
    );
    if (!section) return [];
    const body = section[1];

    const flow = body.match(new RegExp(`^[ \\t]+${key}:[ \\t]*\\[(.*)\\][ \\t]*$`, 'm'));
    if (flow) return flow[1].split(',').map(unquote).filter(Boolean);

    const block = body.match(new RegExp(`^[ \\t]+${key}:[ \\t]*\\n((?:[ \\t]*-[ \\t]*.*\\n?)*)`, 'm'));
    if (!block) return [];
    return block[1]
      .split('\n')
      .map((line) => line.replace(/^[ \t]*-[ \t]*/, ''))
      .map(unquote)
      .filter(Boolean);
  }

  // Mirror one skill's on/off switch from KnockDesk's Skills panel into Hermes'
  // own `skills.disabled` list. Both sides now read the same folder, so they
  // have to agree on which entries in it are live — otherwise a skill the user
  // switched off here keeps turning up in every agent's system prompt.
  //
  // Only the one name is added or removed; every other entry is preserved.
  async setSkillDisabled(skillName, disabled) {
    const name = String(skillName || '').trim();
    if (!name) return false;

    const current = await this.apiFetch('/api/config/raw');
    if (!current.ok || !current.data || typeof current.data.yaml !== 'string') return false;

    const existing = this._parseSkillsListKey(current.data.yaml, 'disabled');
    const has = existing.includes(name);
    if (disabled === has) return true;

    const next = disabled ? [...existing, name] : existing.filter((entry) => entry !== name);
    const res = await this.apiFetch('/api/config', {
      method: 'PUT',
      body: { config: { skills: { disabled: next } } },
    });
    return res.ok;
  }

  // ── Mobile Remote — KnockDesk phone ko Hermes ka apna platform bana dena ────
  //
  // Phone ab WhatsApp, Telegram aur Discord ke barabar ka platform hai, unhi
  // ke saath ek hi qatar mein. Is ka faida ye hai ke Hermes ka poora nizam —
  // tool ka progress, sochne ka amal, streaming jawab, slash commands, cron
  // se khud paighaam bhejna — phone par MUFT chalta hai. Us ki naqal banane
  // ki koshish hamesha asal se peeche rehti.
  //
  // Yahan teen kaam hote hain, aur teenon Hermes ke APNE raston se:
  //
  //   1. plugin ko user ke Hermes folder mein rakhna (~/.hermes/plugins/)
  //   2. usay `plugins.enabled` mein daalna (user plugins opt-in hote hain)
  //   3. bridge ka pata aur key .env mein likhna (PUT /api/env)
  //
  // Hermes ka source aur uska install folder — dono ko haath nahi lagta.
  //
  // Gateway ka restart SIRF tab hota hai jab waqai kuch badla ho. Python
  // plugin boot par ek dafa load hota hai aur .env bhi gateway ke start par
  // parhi jati hai, is liye tabdeeli ke baad bounce lazmi hai — magar har app
  // launch par bounce karna Hermes ko be-wajah tang karna hai.
  //
  // ⚠ ISAY SEEDHA MAT BULAO. `requestKnockDeskPlatform()` istemal karo — wo
  // intezaar aur dobara koshish dono sambhalta hai. Ye sirf asal kaam hai.

  /**
   * Mobile Remote ka setup — "jab ho sake tab, magar ho kar rahe."
   *
   * ══════════════════════════════════════════════════════════════════════
   *  YE FUNCTION KYUN WAJOOD MEIN AAYA
   * ══════════════════════════════════════════════════════════════════════
   *
   *  Pehle renderer seedha `ensureKnockDeskPlatform()` bulata tha — ek dafa, us
   *  lamhe jab uska Supabase channel jur jata tha. Agar us waqt Hermes tayyar
   *  na hota (packaged app mein hamesha yehi hota hai) to jawab aata
   *  "Hermes abhi tayyar nahi hai", renderer usay console mein likh deta, aur
   *  BAAT WAHIN KHATAM. Gateway kabhi start na hota — aur gateway hi wo cheez
   *  hai jo Python plugin ko chalati hai, jo bridge se jur kar phone ka sabz
   *  nuqta banata hai.
   *
   *  Us design mein ek khamoshi wali ghalti thi: setup ka WAQT us cheez se
   *  bandha hua tha jiska us se koi taalluq nahi (Supabase ka channel), us
   *  cheez ke bajaye jis par wo waqai munhasir hai (Hermes ka tayyar hona).
   *
   *  Ab tarteeb ulti hai — aur yehi durust hai:
   *
   *      koi bhi darkhwast de sakta hai, kisi bhi waqt
   *              ↓  (yaad rakhi jati hai)
   *      Hermes tayyar hone par KHUD chalti hai
   *              ↓  (nakaam ho to backoff ke saath dobara)
   *      gateway chalu → plugin juda → phone par sabz nuqta
   *
   *  Is liye ye function kabhi "nahi ho saka" nahi kehta — wo sirf "abhi
   *  nahi, magar yaad hai" kehta hai.
   *
   * ══════════════════════════════════════════════════════════════════════
   *  DO JAGAH SE AATI HAI, AUR DONO ZAROORI HAIN
   * ══════════════════════════════════════════════════════════════════════
   *
   *    main.js       — bridge khulte hi, chatId auth.json se. Is ka faida ye
   *                    hai ke Mobile Remote ab renderer ka MOHTAAJ NAHI: app
   *                    ka window bhale der se paint ho, setup chalta rehta
   *                    hai.
   *    renderer      — Supabase channel jurte hi, asal user id ke saath. Ye
   *                    zyada mustanad hai (token abhi abhi refresh hua hoga),
   *                    is liye chatId badla ho to setup dobara chalta hai.
   *
   * @returns {{ok: boolean, pending: boolean, error?: string}}
   *          `pending: true` ka matlab "qatar mein hai", nakaami nahi.
   */
  requestKnockDeskPlatform({ bridgeUrl, bridgeKey, chatId } = {}) {
    const prev = this._knockdeskWanted;

    // Khali value purani ko nahi mitati. Ye jaan bujh kar hai: bridge apna
    // pata deta hai magar chatId nahi janta, aur renderer chatId deta hai
    // magar bridge ka pata nahi janta. Dono ke tukre mil kar poori tasveer
    // banate hain.
    const next = {
      bridgeUrl: bridgeUrl || (prev && prev.bridgeUrl) || '',
      bridgeKey: bridgeKey || (prev && prev.bridgeKey) || '',
      chatId: chatId || (prev && prev.chatId) || '',
    };

    if (!next.bridgeUrl || !next.bridgeKey) {
      return { ok: false, pending: false, error: 'Bridge ka pata ya key nahi mili.' };
    }

    const changed =
      !prev ||
      prev.bridgeUrl !== next.bridgeUrl ||
      prev.bridgeKey !== next.bridgeKey ||
      prev.chatId !== next.chatId;

    this._knockdeskWanted = next;

    // chatId ke baghair setup ka koi faida nahi: .env mein khali
    // STONIC_CHAT_ID likhne ka matlab hai authorization ki list khali, aur
    // phir Hermes har paighaam rad kar deta hai. Sign in hone tak intezaar
    // us se behtar hai — renderer login ke baad khud asli id le kar aata hai.
    //
    // `pending` yahan FALSE rehta hai, aur ye jaan bujh kar hai: qatar mein
    // waqai kuch nahi hai. Agar isay `true` kar dete to splash us cheez ka
    // intezaar karti jo aane wali hi nahi (sign in kiye baghair), aur bina
    // login wala user har boot par ek fazool waqfa jhelta.
    if (!next.chatId) {
      this._knockdeskPending = false;
      this._broadcast();
      return { ok: false, pending: false, error: 'Abhi sign in nahi hua.' };
    }

    // Kuch badla hai (aam tor par user badla) — purani "ho chuka hai" wali
    // yaad ab jhooti hai. Naye siray se, aur koshishon ka hisaab bhi naya.
    if (changed) {
      this._knockdeskReady = false;
      this._knockdeskAttempts = 0;
      this._knockdeskLastError = null;
    }

    if (this._knockdeskReady) {
      return { ok: true, pending: false };
    }

    this._knockdeskPending = true;
    // Splash ko foran bata do ke ek marhala aur baqi hai — warna wo agli
    // dharkan (15s) tak samajhti rahegi ke sab ho chuka.
    this._broadcast();
    this._runKnockDeskSetupSoon(0);
    return { ok: true, pending: true };
  }

  /** Agli koshish ka waqt mukarrar karna. Ek waqt mein sirf ek timer. */
  _runKnockDeskSetupSoon(delayMs) {
    if (!this._knockdeskPending) return;
    if (this._knockdeskRetryTimer) clearTimeout(this._knockdeskRetryTimer);
    this._knockdeskRetryTimer = setTimeout(() => {
      this._knockdeskRetryTimer = null;
      void this._runKnockDeskSetup();
    }, delayMs);
  }

  /**
   * Ek koshish — aur nakaami par agli ka bandobast.
   *
   * Hermes tayyar na ho to ye koshish GINTI MEIN NAHI aati. Farq ahem hai:
   * intezaar nakaami nahi hai, aur agar hum har intezaar ko ek koshish gin
    * lein to `KNOCKDESK_SETUP_MAX_ATTEMPTS` Hermes ke uthne se pehle hi khatam ho
   * jaye — yani theek wohi khamosh haar jise ye poora code rokne ke liye hai.
   *
   * Aam tor par is raaste ki zaroorat parti hi nahi: `_setState` 'ready' ki
   * guzargah par khud bula leta hai. Ye us baariq soorat ke liye hai jahan
   * timer aur halat ka waqt aapas mein guzar jaye (jaise Hermes ek lamhe ke
   * liye 'starting' par wapas chala jaye). Ek hi timer chalta hai, is liye do
   * setup kabhi saath nahi chalte.
   */
  async _runKnockDeskSetup() {
    if (!this._knockdeskPending || !this._knockdeskWanted) return;

    if (this.state !== 'ready') {
      this._runKnockDeskSetupSoon(KNOCKDESK_SETUP_RETRY_MAX_MS);
      return;
    }

    let res;
    try {
      res = await this.ensureKnockDeskPlatform(this._knockdeskWanted);
    } catch (err) {
      res = { ok: false, error: err.message };
    }

    if (res && res.ok) {
      this._knockdeskPending = false;
      this._knockdeskAttempts = 0;
      this._knockdeskLastError = null;
      if (this._knockdeskRetryTimer) {
        clearTimeout(this._knockdeskRetryTimer);
        this._knockdeskRetryTimer = null;
      }
      console.log(
        `[Hermes] Mobile Remote tayyar hai${res.restarted ? ' (gateway restart hua)' : ''}.`,
      );
      // Splash aur Settings dono isi khabar par chalte hain.
      this._broadcast();
      return;
    }

    this._knockdeskAttempts += 1;
    this._knockdeskLastError = (res && res.error) || 'unknown';

    if (this._knockdeskAttempts >= KNOCKDESK_SETUP_MAX_ATTEMPTS) {
      // Haar maan lete hain, magar KHAMOSHI SE NAHI — aur yehi asal sabaq
      // hai. Purana code bhi yahin haar-ta tha, bas kisi ko batata nahi tha.
      // Ab wajah `knockdeskError` mein jati hai aur Settings ka Mobile Remote
      // panel usay saaf lafzon mein dikhata hai.
      this._knockdeskPending = false;
      console.error(
        `[Hermes] Mobile Remote ka setup ${this._knockdeskAttempts} koshishon ke baad bhi nahi hua:`,
        this._knockdeskLastError,
      );
      this._broadcast();
      return;
    }

    const delay = Math.min(
      KNOCKDESK_SETUP_RETRY_MAX_MS,
      KNOCKDESK_SETUP_RETRY_MIN_MS * 2 ** (this._knockdeskAttempts - 1),
    );
    console.warn(
      `[Hermes] Mobile Remote ka setup nakaam (${this._knockdeskLastError}) — ` +
        `${Math.round(delay / 1000)}s baad koshish ${this._knockdeskAttempts + 1}.`,
    );
    this._broadcast();
    this._runKnockDeskSetupSoon(delay);
  }

  async ensureKnockDeskPlatform({ bridgeUrl, bridgeKey, chatId }) {
    if (!bridgeUrl || !bridgeKey) {
      return { ok: false, error: 'Bridge ka pata ya key nahi mili.' };
    }
    if (this._knockdeskReady) return this._knockdeskReady;

    this._knockdeskReady = (async () => {
      try {
        if (this.state !== 'ready') {
          return { ok: false, error: 'Hermes abhi tayyar nahi hai.' };
        }

        // 1 ── Plugin
        const installed = ensureKnockDeskPlugin(this.getHermesHome());
        if (!installed.ok) {
          return { ok: false, error: `Plugin install nahi hua: ${installed.error}` };
        }
        // 1b ── Computer-use plugin (`computer_task`). Iski nakaami Mobile
        // Remote ko nahi rokti — sirf wo ek tool ghayab rehta hai.
        const computer = ensureKnockDeskComputerPlugin(this.getHermesHome());
        if (!computer.ok) console.warn('[Hermes] Computer plugin install nahi hua:', computer.error);
        // 1c ── Memory Core ka provider (`knockdesk-memory`). Wohi usool: nakaami
        // Mobile Remote ko nahi rokti, Hermes bas apni built-in memory par
        // chalta rehta hai. Aam tor par ye `start()` mein ho chuka hota hai aur
        // yahan kuch nahi badalta; ye us surat ke liye hai jab wahan Hermes ka
        // ghar abhi bana hi nahi tha (pehli dafa) ya copy nakaam hui thi.
        const memory = this._installMemoryPlugin();

        // 2 ── plugins.enabled
        //
        // Do naam daalte hain: folder ka naam (`knockdesk ai`) aur manifest ka
        // naam (`knockdesk-platform`). Hermes dono qubool karta hai, aur do
        // daal dene se ye poora sawaal hi khatam ho jata hai ke wo kis naam
        // se dhoondta hai — ek ghalti jo chalte waqt bilkul khamoshi se
        // nakaam hoti hai.
        // 2b ── Purane (`knockdesk*`) plugin folder hatana (neeche dekho).
        this._removeLegacyPluginDirs();
        const enabledChanged = await this._ensureKnockDeskPluginEnabled();
        if (enabledChanged === null) {
          return { ok: false, error: 'Hermes ki config parhi nahi ja saki.' };
        }

        // 3 ── .env
        const envChanged = await this._ensureKnockDeskEnv({ bridgeUrl, bridgeKey, chatId });

        // 3b ── memory.provider
        //
        // .env ke BAAD, jaan bujh kar. Provider tabhi "available" hota hai jab
        // bridge ka pata aur key env mein hon; agar config pehle likh dete to
        // beech mein banne wala agent provider ko na-mojood paata, aur Hermes
        // us agent se dobara poochta hi nahi. Files na pohnchi hon to config
        // ko haath nahi lagate: chuna hua naam ek khali folder ki taraf hota.
        if (memory.ok) await this._ensureMemoryProvider();

        // 4 ── Gateway
        //
        // Band hoti app gateway nahi chalati. Upar ke qadam `await` par rukte
        // hain, aur us dauran quit shuru ho sakta hai — us ke baad start
        // bhejna theek wo orphan process banata jise shutdown rok-ta hai.
        if (this._stopping) return { ok: false, error: 'App band ho rahi hai.' };
        // Memory plugin sirf tab bounce maangta hai jab us ka code BADLA ho
        // (`_memoryPluginUpdated`). Pehli install aur `memory.provider` ki
        // likhayi par restart nahi: tafseel `_installMemoryPlugin` par.
        const mustBounce = installed.changed || Boolean(computer.changed) || this._memoryPluginUpdated
          || enabledChanged || envChanged;
        const status = await this.apiFetch('/api/status');
        const running = Boolean(status.data && status.data.gateway_running);

        if (mustBounce && running) {
          console.log('[Hermes] Mobile Remote ke liye gateway restart kar rahe hain.');
          const bounced = await this.apiFetch('/api/gateway/restart', { method: 'POST' });
          // Restart hua hi nahi to gateway abhi purana code chala raha hai:
          // jhanda rehne do, agla setup dobara koshish karega.
          if (bounced && bounced.ok) this._memoryPluginUpdated = false;
        } else if (!running) {
          console.log('[Hermes] Mobile Remote ke liye gateway start kar rahe hain.');
          await this.startGateway();
          // Naya gateway disk se naya code parhta hai.
          this._memoryPluginUpdated = false;
        }

        this._knockdeskReady = true;
        return { ok: true, restarted: mustBounce, version: installed.version };
      } catch (err) {
        return { ok: false, error: err.message };
      } finally {
        // Promise ko yaad nahi rakhte: agar setup nakaam hua to agli koshish
        // naye siray se honi chahiye. Ek yaad rakha hua nakaam promise har
        // baad ki koshish ko wohi purani nakaami de deta.
        this._knockdeskReady = null;
      }
    })();

    return this._knockdeskReady;
  }

  /**
   * One-time rebrand migration: purane `knockdesk*` plugin folder hatana.
   * Sirf tab jab naye (`knockdesk*`) folder marker samet mojood hon — warna
   * haath nahi lagate (aadhi migration se kharab haalat behtar nahi).
   */
  _removeLegacyPluginDirs() {
    try {
      const pairs = [
        ['knockdesk', 'adapter.py', 'knockdesk'],
        ['knockdesk-computer', 'tool.py', 'knockdesk-computer'],
        ['knockdesk-memory', '__init__.py', 'knockdesk-memory'],
      ];
      for (const [fresh, marker, legacy] of pairs) {
        const freshDir = path.join(this.getHermesHome(), 'plugins', fresh);
        const legacyDir = path.join(this.getHermesHome(), 'plugins', legacy);
        if (!fs.existsSync(path.join(freshDir, marker))) continue;
        if (!fs.existsSync(legacyDir)) continue;
        fs.rmSync(legacyDir, { recursive: true, force: true });
        console.log(`[Hermes] Purana plugin folder hataya: plugins/${legacy}`);
      }
    } catch (err) {
      console.warn('[Hermes] Purane plugin folder saaf nahi ho sake:', err.message);
    }
  }

  /** `plugins.enabled` mein KnockDesk ka naam daalna. `null` = config parhi na ja saki. */
  async _ensureKnockDeskPluginEnabled() {
    const current = await this.apiFetch('/api/config/raw');
    if (!current.ok || !current.data || typeof current.data.yaml !== 'string') return null;

    // Read-before-write LAZMI hai: PUT /api/config list ko poora badal deta
    // hai (deep-merge lists ko jorta nahi). Bina parhe likhne se user ke apne
    // enable kiye hue plugins chup-chaap gayab ho jate.
    const LEGACY_NAMES = ['knockdesk', 'knockdesk-platform', 'knockdesk-computer'];
    const existing = this._parseConfigListKey(current.data.yaml, 'plugins', 'enabled');
    const wanted = ['knockdesk', 'knockdesk-platform', 'knockdesk-computer'];
    const missing = wanted.filter((name) => !existing.includes(name));
    const stale = existing.filter((name) => LEGACY_NAMES.includes(name));
    if (missing.length === 0 && stale.length === 0) return false;

    // One-time rebrand migration: purane naam nikalo (unke folder mitaye ja
    // chuke honge), naye daalo. User ke apne plugins ko haath nahi lagate.
    const next = [...existing.filter((name) => !LEGACY_NAMES.includes(name)), ...missing];
    const res = await this.apiFetch('/api/config', {
      method: 'PUT',
      body: { config: { plugins: { enabled: next } } },
    });
    if (!res.ok) {
      console.warn('[Hermes] plugins.enabled likhi nahi ja saki:',
        res.status, (res.data && res.data.error) || '');
      return null;
    }
    console.log('[Hermes] KnockDesk plugin config mein enable ho gaya.');
    return true;
  }

  /**
   * Bridge ka pata, key aur pehchan Hermes ki .env mein.
   *
   * `/api/env` sirf ye batata hai ke koi key SET hai ya nahi — value nahi
   * deta (aur value parhne wala raasta rate-limited hai). Is liye jo hum ne
   * pichli dafa likha tha wo apne paas ek chhoti file mein rakh lete hain aur
   * usi se muqabla karte hain. Is se do faide hain: be-wajah likhna nahi hota
   * (yani be-wajah gateway restart nahi hota), aur badli hui value — misal ke
   * tor par user ne account badal liya — pakri jati hai.
   */
  async _ensureKnockDeskEnv({ bridgeUrl, bridgeKey, chatId }) {
    const desired = {
      STONIC_BRIDGE_URL: bridgeUrl,
      STONIC_BRIDGE_KEY: bridgeKey,
      STONIC_CHAT_ID: chatId || '',
      // Pehra do jagah: bridge par bhi (localhost + secret) aur yahan bhi.
      // Hermes sirf usi KnockDesk account se baat karega jis se desktop par
      // sign in kiya gaya hai — koi aur user id aa bhi jaye to ruk jayegi.
      STONIC_ALLOWED_USERS: chatId || '',
      // Cron aur `send_message` tool ka pata — is ke baghair Hermes khud se
      // phone par kuch nahi bhej sakta ("deliver=knockdesk" chup-chaap girta).
      STONIC_HOME_CHANNEL: chatId || '',
    };
    // One-time rebrand migration: neeche file-level cleanup purani keys ki
    // lines .env se nikaal deta hai (API empty-PUTs ko nazar-andaaz karta hai).

    const env = await this.apiFetch('/api/env');
    const rows = (env.ok && ((env.data && env.data.env) || env.data)) || {};
    const isSet = (name) => {
      const row = rows[name];
      return Boolean(row && typeof row === 'object' ? row.is_set : row);
    };

    const cachePath = path.join(this.getHermesHome(), 'knockdesk-bridge-env.json');
    const legacyCachePath = path.join(this.getHermesHome(), 'knockdesk-bridge-env.json');
    let cached = {};
    try {
      cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      cached = {};
    }

    let changed = false;
    for (const [key, value] of Object.entries(desired)) {
      if (!value) continue;
      if (cached[key] === value && isSet(key)) continue;
      if (await this._putEnv(key, value)) changed = true;
    }
    // File-level cleanup: Hermes empty PUTs ko nazar-andaaz karta hai, is
    // liye purani keys API se saaf nahi hotin — file se lines hatao. Agle
    // gateway bounce (neeche `changed`) par saaf env lagoo hoga.
    try {
      const envPath = path.join(this.getHermesHome(), '.env');
      const raw = fs.readFileSync(envPath, 'utf8');
      const lines = raw.split('\n');
      const kept = lines.filter((ln) => !/^\s*KNOCKDESK_(BRIDGE_URL|BRIDGE_KEY|CHAT_ID|ALLOWED_USERS|HOME_CHANNEL)\s*=/.test(ln));
      if (kept.length !== lines.length) {
        fs.writeFileSync(envPath, kept.join('\n'));
        changed = true;
        console.log('[Hermes] Purani KNOCKDESK_* keys .env se hata di gayin.');
      }
    } catch { /* agli dafa sahi — gateway purani keys nazar-andaaz karta hai */ }
    try {
      if (fs.existsSync(legacyCachePath)) fs.rmSync(legacyCachePath, { force: true });
    } catch { /* purani cache reh gayi to koi harj nahi */ }

    if (changed) {
      try {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify(desired, null, 2));
      } catch (err) {
        // Save na ho saki: agli dafa dobara likh denge. Ek zaid restart ka
        // nuqsan hai, kharabi ka nahi.
        console.warn('[Hermes] KnockDesk env cache save nahi hui:', err.message);
      }
      console.log('[Hermes] KnockDesk bridge ki settings .env mein likh di gayin.');
    }

    return changed;
  }

  // ── Memory Core ka provider (`knockdesk-memory`) ─────────────────────────────
  //
  // Hermes ko wohi yaadash dena jo voice assistant istemal karta hai. Do kaam:
  //
  //   1. plugin ki files Hermes ke ghar mein rakhna  (`_installMemoryPlugin`)
  //   2. config mein `memory.provider` chun-na        (`_ensureMemoryProvider`)
  //
  // Dono nakaam ho sakte hain aur dono ki nakaami be-zarar hai: Hermes apni
  // built-in memory (MEMORY.md / USER.md) par pehle jaisa chalta rehta hai.
  // Is liye yahan se kuch throw nahi hota aur koi setup is par nahi rukta.

  /**
   * Plugin ki files copy karna (sirf fs; Hermes ke tayyar hone ka mohtaaj nahi).
   *
   * ── GATEWAY KAB RESTART HOTA HAI ────────────────────────────────────────
   *
   *   pehli install : NAHI. Kisi process ne ye module abhi load hi nahi kiya,
   *                   aur `memory.provider` Hermes ki un keys mein hai jin ke
   *                   badalte hi wo agla agent naye siray se banata hai
   *                   (gateway/run.py: `_CACHE_BUSTING_CONFIG_KEYS`).
   *   update        : HAAN, ek dafa. Python load ho chuka module `sys.modules`
   *                   se dobara istemal karta hai; naya code sirf naye process
   *                   mein aata hai.
   *
   * Ye faisla `previous` (copy se pehle ka version) par hai, `changed` par
   * nahi. Sirf `changed` dekhte to har purane user ka gateway update ke baad
   * pehli launch par ek be-wajah restart khata.
   *
   * Update ka jhanda FIELD mein rehta hai, return value mein nahi. Copy aam
   * tor par `start()` mein hoti hai (dashboard ke spawn se pehle), aur gateway
   * ka faisla baad mein `ensureKnockDeskPlatform` mein. Wahan doosri call ko
   * "kuch nahi badla" milta hai, is liye pehli call ka natija yaad rakhna
   * lazmi hai, warna pehle se chalta gateway hamesha purana code chalata.
   */
  _installMemoryPlugin() {
    let res;
    try {
      res = ensureKnockDeskMemoryPlugin(this.getHermesHome());
    } catch (err) {
      res = { ok: false, changed: false, error: err.message };
    }
    if (!res.ok) {
      console.warn('[Hermes] Memory plugin install nahi hua (Hermes apni built-in memory par chalega):', res.error);
      return res;
    }
    if (res.changed && res.previous) {
      this._memoryPluginUpdated = true;
      // Jo dashboard hum ne khud nahi chalaya (adopt kiya hua) usay hum
      // restart nahi karte. Us ke andar bane agents purana code chalate
      // rahenge jab tak wo khud dobara na chale.
      if (this.state === 'ready') {
        console.log('[Hermes] Memory plugin update hua; chalta hua dashboard naya code apne agle start par uthayega.');
      }
    }
    return res;
  }

  /**
   * Config mein `memory.provider: knockdesk-memory` — sirf jab jagah khali ho.
   *
   *   khali            → hamara naam likh do
   *   pehle se hamara  → kuch nahi (koi likhayi nahi)
   *   kisi aur ka      → haath nahi lagate. User ne Honcho ya Mem0 jaisa
   *                      provider khud chuna hai; Hermes ek waqt mein ek hi
   *                      chalata hai, aur us ka faisla hamare faisle se bara hai.
   *
   * Pehle parhna lazmi hai: likhayi sirf tab jab value waqai alag ho. Wohi
   * tareeqa jo `_ensureSttProvider` ka hai (GET /api/config, phir PUT jo
   * server par deep-merge hota hai, yani sirf yehi ek key hilti hai).
   *
   * `plugins.enabled` mein ye naam NAHI jata: memory provider us raaste se
   * load hi nahi hota (Hermes ke aam plugin context par
   * `register_memory_provider` hai hi nahi).
   */
  async _ensureMemoryProvider() {
    if (this._memoryProviderApplied) return;
    try {
      const cfg = await this.apiFetch('/api/config');
      // Parhi na ja saki: andaze se likhna mana hai. Agla setup dobara dekhega.
      if (!cfg.ok || !cfg.data || typeof cfg.data !== 'object') return;

      const section = cfg.data.memory;
      const current = String((section && typeof section === 'object' && section.provider) || '').trim();
      if (current === MEMORY_PLUGIN_NAME) {
        this._memoryProviderApplied = true;
        return;
      }
      // One-time rebrand migration: beech ke (`knockdesk-memory`) ya purane
      // naam ko canonical naam par le aao — neeche wala likhne ka raasta
      // waise hi chalta hai. Khaali jagah par bhi wahi raasta hai.
      if (current && current !== 'knockdesk-memory' && current !== 'knockdesk-memory') {
        this._memoryProviderApplied = true;
        console.log(`[Hermes] Memory provider "${current}" pehle se chuna hua hai; KnockDesk Memory usay nahi badalta.`);
        return;
      }

      const res = await this.apiFetch('/api/config', {
        method: 'PUT',
        body: { config: { memory: { provider: MEMORY_PLUGIN_NAME } } },
      });
      if (res.ok) {
        this._memoryProviderApplied = true;
        console.log('[Hermes] KnockDesk Memory Hermes ka memory provider ban gaya.');
      } else {
        // Non-fatal: Hermes built-in memory par chalta hai, aur agla setup
        // (ya agli app launch) dobara koshish karta hai.
        console.warn('[Hermes] memory.provider likha nahi ja saka:',
          res.status, (res.data && res.data.error) || '');
      }
    } catch (err) {
      console.warn('[Hermes] memory.provider set nahi ho saka:', err.message);
    }
  }

  // Hermes' DEFAULT_CONFIG hardcodes `stt.provider: "local"` (faster-whisper),
  // and load_config() always merges those defaults — so the key is never
  // absent and _get_provider() never falls through to the auto-detect that
  // would have noticed GROQ_API_KEY. A user who saves a Groq key therefore
  // still gets a `local` transcriber that isn't installed: every inbound
  // WhatsApp voice note retries a pip install of faster-whisper and then
  // fails with "No STT provider available".
  //
  // Settings writes this whenever a key is saved. This is the same repair for
  // installs upgraded from a build that predates that — those users never
  // reopen the voice panel, they just send a voice note and find it broken.
  //
  // Only ever flips `local` → `groq`, and only when a key actually exists:
  // an explicit `openai`/`elevenlabs`/`xai` choice is the user's and is left
  // alone.
  async _ensureSttProvider() {
    if (this._sttProviderApplied) return;

    const env = await this.apiFetch('/api/env');
    if (!env.ok) return;
    const rows = (env.data && env.data.env) || env.data || {};
    const groq = rows.GROQ_API_KEY;
    // /api/env reports presence, never the secret itself.
    if (!(groq && typeof groq === 'object' ? groq.is_set : groq)) return;

    const cfg = await this.apiFetch('/api/config');
    if (!cfg.ok) return;
    const current = String((cfg.data && cfg.data.stt && cfg.data.stt.provider) || '');
    if (current !== 'local') {
      this._sttProviderApplied = true; // already groq, or a deliberate choice
      return;
    }

    const res = await this.apiFetch('/api/config', {
      method: 'PUT',
      body: { config: { stt: { provider: 'groq' } } },
    });
    if (res.ok) {
      this._sttProviderApplied = true;
      console.log('[Hermes] Speech-to-text switched to Groq (a key is configured).');
    } else {
      // Non-fatal, and retried on the next start(). Saving the key from
      // Settings writes the same value, so this is the backstop, not the
      // only path.
      console.warn('[Hermes] Could not switch speech-to-text to Groq:',
        res.status, (res.data && res.data.error) || '');
    }
  }

  // Hermes already watches for a wedged turn: `agent.gateway_timeout` is an
  // INACTIVITY budget (gateway/run.py) — an agent streaming tokens or running
  // tools can work for hours, but one with no API response and no tool call for
  // that long is interrupted and the user gets told why. What it is not, at the
  // shipped default of 1800s, is useful on WhatsApp: the session lock is held
  // for the whole time, so every later message queues silently behind it and the
  // chat looks dead for half an hour before anything is said.
  //
  // Ten minutes of total silence is already a hang. Warn at five so the user
  // hears something before the turn is cut.
  //
  // Only lowered when the value is still Hermes' untouched default — the key is
  // never absent (load_config() merges DEFAULT_CONFIG), so "did the user choose
  // this?" can only be answered by comparing against that default.
  //
  // Read at gateway startup, not per turn, so this lands on the next gateway
  // start rather than the running one.
  async _ensureGatewayTimeout() {
    if (this._gatewayTimeoutApplied) return;

    const cfg = await this.apiFetch('/api/config');
    if (!cfg.ok) return;
    const agent = (cfg.data && cfg.data.agent) || {};
    if (Number(agent.gateway_timeout) !== HERMES_DEFAULT_GATEWAY_TIMEOUT) {
      this._gatewayTimeoutApplied = true;  // the user (or a past run) set their own
      return;
    }

    const res = await this.apiFetch('/api/config', {
      method: 'PUT',
      body: {
        config: {
          agent: {
            gateway_timeout: STUCK_TURN_TIMEOUT_S,
            gateway_timeout_warning: STUCK_TURN_WARNING_S,
          },
        },
      },
    });
    if (res.ok) {
      this._gatewayTimeoutApplied = true;
      console.log(`[Hermes] Stuck-turn timeout set to ${STUCK_TURN_TIMEOUT_S}s (was the ${HERMES_DEFAULT_GATEWAY_TIMEOUT}s default).`);
    } else {
      // Non-fatal: the 30-minute default still recovers, just slowly.
      console.warn('[Hermes] Could not lower the stuck-turn timeout:',
        res.status, (res.data && res.data.error) || '');
    }
  }

  // ── Hermes run API (api_server platform) ──────────────────────────────
  //
  // Agent Town's seats used to be driven by spawning `hermes chat -q` per task,
  // which meant a task's life was tied to a socket and capped by a timer we
  // invented. Hermes already ships the right thing: an asynchronous run API
  // (POST /v1/runs, SSE events, pollable status kept for an hour) served by its
  // api_server platform. It only needs to be switched on, which is three env
  // vars written through Hermes' own /api/env — no Hermes source is touched.
  //
  // The key is generated once and then reused: /api/env reports presence only,
  // so we read the real value back through /api/env/reveal rather than
  // clobbering a key the user may already have handed to another client.
  async _ensureRunApi() {
    if (this.runApi) return this.runApi;

    const env = await this.apiFetch('/api/env');
    if (!env.ok) return null;
    const rows = (env.data && env.data.env) || env.data || {};
    const isSet = (name) => {
      const row = rows[name];
      return Boolean(row && typeof row === 'object' ? row.is_set : row);
    };

    let key = null;
    if (isSet('API_SERVER_KEY')) {
      const revealed = await this.apiFetch('/api/env/reveal', {
        method: 'POST',
        body: { key: 'API_SERVER_KEY' },
      });
      if (revealed.ok && revealed.data && revealed.data.value) {
        key = String(revealed.data.value);
      } else {
        // Rate-limited or unreadable. Do NOT overwrite someone else's key —
        // leave it for the next attempt; Agent Town stays on the CLI engine.
        console.warn('[Hermes] API_SERVER_KEY exists but could not be read; retrying later.');
        return null;
      }
    } else {
      key = crypto.randomBytes(32).toString('hex');
      const wrote = await this._putEnv('API_SERVER_KEY', key);
      if (!wrote) return null;
      console.log('[Hermes] Generated an API_SERVER_KEY for the local run API.');
    }

    if (!isSet('API_SERVER_ENABLED')) await this._putEnv('API_SERVER_ENABLED', 'true');
    if (!isSet('API_SERVER_PORT')) await this._putEnv('API_SERVER_PORT', String(RUN_API_PORT));

    const port = rows.API_SERVER_PORT && rows.API_SERVER_PORT.value
      ? String(rows.API_SERVER_PORT.value)
      : String(RUN_API_PORT);

    this.runApi = { url: `http://127.0.0.1:${port}`, key };
    return this.runApi;
  }

  async _putEnv(key, value) {
    const res = await this.apiFetch('/api/env', { method: 'PUT', body: { key, value } });
    if (!res.ok) {
      console.warn(`[Hermes] Could not set ${key}:`, res.status, (res.data && res.data.error) || '');
      return false;
    }
    // Main process ki apni likhayi bhi usi yaad mein jati hai jise renderer ka
    // raasta parhta hai. Do alag yaadein rakhne ka matlab hota ke yahan likhi
    // hui key wahan "nayi" lagti aur ek zaid restart ho jata.
    this.rememberEnvValue(key, String(value == null ? '' : value));
    return true;
  }

  /**
   * Resolve the run API for a caller (Agent Town), starting the gateway if it
   * isn't already up — api_server is a gateway platform, so it only listens
   * while the gateway runs.
   *
   * Concurrent callers share one attempt. Returns null when Hermes isn't ready
   * yet; the caller is expected to keep working on its fallback path and ask
   * again later rather than treat this as an error.
   */
  async ensureRunApi() {
    if (this.runApi && this._runApiVerifiedAt && Date.now() - this._runApiVerifiedAt < 60_000) {
      return this.runApi;
    }
    // After a failed attempt, back off. Without this a run API that cannot come
    // up (port taken, platform misconfigured) would have us bouncing the
    // gateway every time Agent Town asked.
    if (this._runApiFailedAt && Date.now() - this._runApiFailedAt < 5 * 60_000) return null;
    if (this._runApiPromise) return this._runApiPromise;

    this._runApiPromise = (async () => {
      try {
        if (this.state !== 'ready') return null;
        const cfg = await this._ensureRunApi();
        if (!cfg) return null;

        if (await this._runApiListening(cfg)) {
          this._runApiVerifiedAt = Date.now();
          return cfg;
        }

        // Configured but not answering. Either the gateway isn't up, or it is
        // but was started before API_SERVER_* landed in .env — env is read at
        // gateway start, so that case needs a bounce, not a start.
        const status = await this.apiFetch('/api/status');
        const gatewayRunning = Boolean(status.data && status.data.gateway_running);
        if (gatewayRunning) {
          console.log('[Hermes] Restarting the gateway to pick up the run API settings.');
          await this.apiFetch('/api/gateway/restart', { method: 'POST' });
        } else {
          console.log('[Hermes] Starting the gateway so Agent Town can use the run API.');
          await this.startGateway();
        }

        // Give it a moment to bind, then confirm rather than assume.
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          if (await this._runApiListening(cfg)) {
            this._runApiVerifiedAt = Date.now();
            return cfg;
          }
        }
        console.warn('[Hermes] Run API did not come up; Agent Town stays on the CLI engine.');
        this._runApiFailedAt = Date.now();
        return null;
      } finally {
        this._runApiPromise = null;
      }
    })();

    return this._runApiPromise;
  }

  async _runApiListening(cfg) {
    try {
      const res = await axios.get(`${cfg.url}/health`, { timeout: 2500, validateStatus: () => true });
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }

  // ── Binary discovery (no install/config writes — read-only checks) ───
  // Prefers the Hermes we bundle in the installer; falls back to a
  // hand-installed one. See services/hermes-runtime.js.
  resolveExe() {
    return resolveHermesExe();
  }

  async _probeStatus(timeoutMs = 2500) {
    const res = await axios.get(`${this.baseUrl}/api/status`, { timeout: timeoutMs });
    return res.data;
  }

  // The dashboard injects its session token into index.html; that page is
  // the source of truth (same technique Hermes' own desktop app uses).
  async _fetchToken() {
    try {
      const res = await axios.get(`${this.baseUrl}/`, { timeout: 4000, responseType: 'text' });
      const m = /window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/.exec(String(res.data || ''));
      this.token = m ? m[1] : null;
    } catch (err) {
      console.warn('[Hermes] Failed to read session token:', err.message);
      this.token = null;
    }
    return this.token;
  }

  // Ship KnockDesk's dashboard themes as Hermes USER themes (~/.hermes is user
  // data — Hermes discovers *.yaml in dashboard-themes/ natively, so the
  // embedded panels can match the host app without touching Hermes source.
  // Existing files are never overwritten (the user may have customised them).
  _ensureKnockDeskThemes() {
    try {
      const themesDir = path.join(os.homedir(), '.hermes', 'dashboard-themes');
      fs.mkdirSync(themesDir, { recursive: true });
      const typography =
        'typography:\n' +
        '  fontSans: \'"Inter", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif\'\n' +
        '  fontMono: \'"JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace\'\n' +
        'layout:\n  radius: "0.5rem"\n  density: comfortable\n';
      const themes = {
        'knockdesk-iron.yaml':
          '# Written by KnockDesk AI (user data — Hermes source untouched).\n' +
          'name: knockdesk-iron\nlabel: KnockDesk Iron\n' +
          'description: Iron Man workshop HUD — steel blue and pale arc-reactor ice\n' +
          'palette:\n  background: "#0c1720"\n  midground: "#A8D8EE"\n' +
          '  foreground:\n    hex: "#ffffff"\n    alpha: 0\n' + typography,
        'knockdesk-jarvis.yaml':
          '# Written by KnockDesk AI (user data — Hermes source untouched).\n' +
          'name: knockdesk-jarvis\nlabel: KnockDesk Jarvis\n' +
          'description: Classic KnockDesk — electric cyan on deep space\n' +
          'palette:\n  background: "#0b141b"\n  midground: "#6FE3F7"\n' +
          '  foreground:\n    hex: "#ffffff"\n    alpha: 0\n' + typography,
      };
      for (const [file, body] of Object.entries(themes)) {
        const dest = path.join(themesDir, file);
        if (!fs.existsSync(dest)) fs.writeFileSync(dest, body, 'utf-8');
      }
    } catch (err) {
      console.warn('[Hermes] Could not write KnockDesk dashboard themes:', err.message);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────
  async start() {
    if (this.state === 'starting' || this.state === 'ready') return this.getState();
    this._stopping = false;
    this._setState('starting');
    this._ensureKnockDeskThemes();
    // Memory provider ki files dashboard ke spawn se PEHLE taaza kar do. App
    // update ke baad yehi wo lamha hai jahan naya plugin code purane ki jagah
    // leta hai: dashboard ek dafa purana module load kar le to apne agle start
    // tak wohi chalata hai. Sirf chand `existsSync` aur (update par) do files
    // ki copy. Hermes ka ghar abhi na bana ho (bilkul pehli launch) to kuch
    // nahi karte: wo folder Hermes khud banaye, aur update karne ko wahan kuch
    // hai bhi nahi. Us surat mein install `ensureKnockDeskPlatform` mein hota hai.
    if (fs.existsSync(this.getHermesHome())) this._installMemoryPlugin();

    // 0. Baseline: gateway/bridge processes already running are the user's, not
    //    ours. Taken before adopt or spawn so the delta is exact.
    try {
      this._preexistingHermes = childRegistry.discoverHermesProcesses();
    } catch (err) {
      console.warn('[Hermes] Could not baseline running Hermes processes:', err.message);
      this._preexistingHermes = [];
    }

    // 1. Adopt an already-running dashboard (user started it manually).
    try {
      const status = await this._probeStatus();
      this.external = true;
      this.lastStatus = status;
      await this._fetchToken();
      this._setState('ready');
      this._startStatusLoop();
      this._ensureApprovalBypass().catch(() => { /* reported inside */ });
      this._ensureSttProvider().catch(() => { /* reported inside */ });
      this._ensureGatewayTimeout().catch(() => { /* reported inside */ });
      this._ensureSkillsExternalDir().catch(() => { /* reported inside */ });
      console.log('[Hermes] Adopted already-running dashboard at', this.baseUrl);
      return this.getState();
    } catch { /* not running — spawn our own below */ }

    // 2. Spawn our own child, exactly the command the user runs by hand.
    this.external = false;
    this.exePath = this.resolveExe();
    console.log('[Hermes] Spawning dashboard:', this.exePath, 'dashboard --no-open');
    try {
      this.child = spawn(this.exePath, ['dashboard', '--no-open'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: hermesSpawnEnv(),
      });
    } catch (err) {
      this._setState('error', `Failed to launch Hermes: ${err.message}`);
      return this.getState();
    }

    const logLine = (buf) => {
      const line = String(buf).trim();
      if (line) console.log('[Hermes]', line.slice(0, 400));
    };
    this.child.stdout?.on('data', logLine);
    this.child.stderr?.on('data', logLine);

    this.child.on('exit', (code) => {
      console.log('[Hermes] dashboard process exited with code', code);
      this.child = null;
      if (!this._stopping) {
        this._stopStatusLoop();
        if (this._autoRestarts < 2) {
          this._autoRestarts++;
          console.warn(`[Hermes] dashboard exited — automatic restart ${this._autoRestarts}/2...`);
          this.state = 'idle';
          this.external = false;
          this._broadcast();
          setTimeout(() => this.start().catch(() => { /* reflected via state */ }), 2000);
        } else {
          this._setState('error', `Hermes dashboard exited unexpectedly (code ${code})`);
        }
      }
    });
    this.child.on('error', (err) => {
      this.child = null;
      this._setState('error', `Hermes launch error: ${err.message}. Is Hermes installed? (install: https://hermes-agent.nousresearch.com)`);
    });

    // 3. Poll readiness.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    await new Promise((resolve) => {
      const tick = async () => {
        if (this._stopping || this.state === 'error') return resolve();
        try {
          const status = await this._probeStatus();
          this.lastStatus = status;
          await this._fetchToken();
          this._autoRestarts = 0;
          this._setState('ready');
          this._startStatusLoop();
          this._ensureApprovalBypass().catch(() => { /* reported inside */ });
          this._ensureSttProvider().catch(() => { /* reported inside */ });
          this._ensureGatewayTimeout().catch(() => { /* reported inside */ });
          this._ensureSkillsExternalDir().catch(() => { /* reported inside */ });
          console.log('[Hermes] Dashboard ready at', this.baseUrl, '(version', status.version + ')');
          return resolve();
        } catch {
          if (Date.now() > deadline) {
            this._setState('error', 'Hermes dashboard did not become ready in time.');
            return resolve();
          }
          this._readyPoller = setTimeout(tick, READY_POLL_MS);
        }
      };
      tick();
    });
    return this.getState();
  }

  _startStatusLoop() {
    this._stopStatusLoop();
    this._statusTimer = setInterval(async () => {
      try {
        this.lastStatus = await this._probeStatus();
        // The bridge appears seconds after the gateway, and the dashboard can
        // start a gateway on its own, so keep the owned set current instead of
        // recording once at startup. Only while a gateway is actually up, and
        // throttled — each pass costs a process scan.
        if (this.lastStatus && this.lastStatus.gateway_running) this._recordOwnedProcesses();
        this._superviseGateway(this.lastStatus);
        this._broadcast();
      } catch {
        // Dashboard vanished (crash or manual stop). Self-heal: start() probes
        // first, so if it was a blip we re-adopt; otherwise we spawn our own.
        if (this.state === 'ready' && !this._stopping) {
          console.warn('[Hermes] Lost connection to dashboard — attempting automatic restart...');
          this._stopStatusLoop();
          // start() guards on 'starting'/'ready', so drop to 'idle' first.
          this.state = 'idle';
          this.external = false;
          this.child = null;
          this._broadcast();
          this.start().catch((err) => {
            this._setState('error', `Automatic Hermes restart failed: ${err.message}`);
          });
        }
      }
    }, STATUS_REFRESH_MS);
  }

  _stopStatusLoop() {
    if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null; }
    if (this._readyPoller) { clearTimeout(this._readyPoller); this._readyPoller = null; }
  }

  /**
   * Gateway ki nigrani — status loop ki har dharkan par ek dafa.
   *
   * ══════════════════════════════════════════════════════════════════════
   *  USOOL: APP KHULI HAI TO GATEWAY CHALNA CHAHIYE
   * ══════════════════════════════════════════════════════════════════════
   *
   *  Phone ka sabz nuqta, WhatsApp aur cron — teenon isi ek process par
   *  khare hain. Pehle wo sirf boot par chalaya jata tha, aur us ke baad mar
   *  jaye to kisi ko khabar nahi hoti thi: dashboard zinda, app theek, magar
   *  phone par "Your Computer is Offline" — app restart hone tak.
   *
   *  Ye wohi kaam hai jo har supervisor karta hai (systemd, PM2, Kubernetes):
   *  zinda hai? nahi → dobara chalao, aur baar baar gire to waqfa barhate jao.
   *
   *  Uthane ka kaam yahan DOBARA nahi likha gaya. Mobile Remote ka setup
   *  (`ensureKnockDeskPlatform`) pehle se jaanta hai ke band gateway ko kaise
   *  chalana hai, aur saath hi plugin/config/.env bhi dobara dekh leta hai.
   *  Is liye yahan sirf wohi darkhwast phir se qatar mein daali jati hai.
   *
   * ══════════════════════════════════════════════════════════════════════
   *  CHAAR SOORTEIN JAHAN YE HAATH NAHI LAGATA
   * ══════════════════════════════════════════════════════════════════════
   *
   *    1. app band ho rahi hai        — band app kuch nahi chalati
   *    2. setup khud chal raha hai    — do haath ek gateway par nahi
   *    3. kisi ne jaan bujh kar roka  — WhatsApp pairing; wo khud wapas chalati hai
   *    4. start/restart abhi bheja    — uthne mein ~20 second lagte hain
   *
   * @returns {boolean} true = is dharkan par gateway dobara uthaya gaya
   */
  _superviseGateway(status, now = Date.now()) {
    if (this._stopping || this.state !== 'ready') return false;

    // Sirf wo gateway jise hum ne khud Mobile Remote ke liye khara kiya tha.
    if (!this._knockdeskReady || this._knockdeskPending || this._knockdeskReady) {
      this._gatewayDownTicks = 0;
      return false;
    }

    // Jawab mein ye khana hi na ho to "band hai" samajhna ghalat hoga — us
    // surat mein har dharkan par ek be-wajah start chalta.
    if (!status || typeof status.gateway_running !== 'boolean') return false;

    if (status.gateway_running) {
      this._gatewayDownTicks = 0;
      if (!this._gatewayUpSince) this._gatewayUpSince = now;
      if (this._gatewayRevivals && now - this._gatewayUpSince >= GATEWAY_STABLE_MS) {
        this._gatewayRevivals = 0;
      }
      return false;
    }
    this._gatewayUpSince = 0;

    const held = this._gatewayHeldAt && now - this._gatewayHeldAt < GATEWAY_HOLD_MAX_MS;
    const starting = this._gatewayCommandAt && now - this._gatewayCommandAt < GATEWAY_COMMAND_GRACE_MS;
    if (held || starting) {
      this._gatewayDownTicks = 0;
      return false;
    }

    this._gatewayDownTicks += 1;
    if (this._gatewayDownTicks < GATEWAY_DOWN_CONFIRM_TICKS) return false;

    // Baar baar girne wala gateway: 30s, 60s, 2m, 4m, 8m, phir har 10 minute.
    const gap = Math.min(
      GATEWAY_REVIVE_MAX_GAP_MS,
      GATEWAY_REVIVE_MIN_GAP_MS * 2 ** this._gatewayRevivals,
    );
    if (this._gatewayLastReviveAt && now - this._gatewayLastReviveAt < gap) return false;

    this._gatewayRevivals += 1;
    this._gatewayLastReviveAt = now;
    this._gatewayDownTicks = 0;
    console.warn(
      `[Hermes] Gateway band mila jabke app chal rahi hai — dobara utha rahe hain (koshish ${this._gatewayRevivals}).`,
    );

    this._knockdeskReady = false;
    this._knockdeskPending = true;
    this._knockdeskAttempts = 0;
    this._knockdeskLastError = null;
    this._runKnockDeskSetupSoon(0);
    return true;
  }

  /**
   * Gateway ko bheja gaya har hukm yahan darj hota hai — `apiFetch` se, is
   * liye koi raasta chhoot nahi sakta (renderer ka `hermes:api` bhi nahi).
   *
   * `stop` ka matlab hai kisi ne jaan bujh kar roka; nigrani us par haath
   * nahi lagati. `start`/`restart` us rok ko khatam karte hain aur gateway ko
   * uthne ki mohlat dete hain.
   */
  _noteGatewayCommand(apiPath) {
    const action = apiPath.split('?')[0].replace(/\/+$/, '').split('/').pop();
    if (action === 'stop') {
      this._gatewayHeldAt = Date.now();
    } else if (action === 'start' || action === 'restart') {
      this._gatewayHeldAt = 0;
      this._gatewayCommandAt = Date.now();
    }
  }

  // The gateway is a sibling of the dashboard, not a child of it: `/api/gateway/start`
  // launches it as its own process, and it owns the WhatsApp bridge. Killing the
  // dashboard's process tree therefore leaves both alive, still answering WhatsApp.
  // So ask Hermes to stop its gateway through its own public API — no Hermes code
  // is touched — while the dashboard that serves that API is still up.
  async _stopGatewayOnShutdown() {
    try {
      await Promise.race([
        this.apiFetch('/api/gateway/stop', { method: 'POST' }),
        new Promise((resolve) => setTimeout(resolve, GATEWAY_STOP_TIMEOUT_MS)),
      ]);
    } catch (err) {
      console.warn('[Hermes] gateway stop failed, leaving it to the sync sweep:', err.message);
    }
  }

  /**
   * Start Hermes' gateway through its own REST API and remember that we did.
   * Callers must go through here rather than hitting /api/gateway/start
   * directly, otherwise the gateway (and the WhatsApp bridge it spawns) is
   * never recognised as ours and outlives the app.
   */
  async startGateway() {
    const res = await this.apiFetch('/api/gateway/start', { method: 'POST' });
    this._gatewayStartedByUs = true;
    // The gateway process (and the bridge it spawns) take a few seconds to
    // exist; the status loop keeps refining this afterwards.
    setTimeout(() => this._recordOwnedProcesses(true), 4000);
    return res;
  }

  /**
   * Bounce the gateway so it re-reads credentials, if one is running.
   *
   * API keys are the one setting that does NOT reach a live gateway. Hermes
   * resolves provider credentials through `get_secret()` (agent/secret_scope.py),
   * which reads `os.environ` and never falls back to the .env file — and the
   * gateway's environment is a snapshot from when it was spawned. Nothing in the
   * gateway calls `reload_env()`. So a key saved from Settings lands on disk and
   * in the dashboard's memory while the gateway keeps using the old one (or none
   * at all) until it restarts, which looked exactly like "the key didn't save".
   *
   * Model and provider changes need none of this — those live in config.yaml,
   * whose cache is mtime-keyed, and the gateway rebuilds its cached agent when
   * the model signature changes.
   *
   * A no-op when no gateway is up: the next start reads the new .env anyway.
   * Failures are logged, not thrown — the key IS saved either way, and the
   * caller's success message must not turn into an error over the bounce.
   */
  async restartGatewayForCredentialChange() {
    const status = await this.apiFetch('/api/status');
    if (!(status.ok && status.data && status.data.gateway_running)) {
      return { ok: true, restarted: false };
    }

    // ── AAKHRI JAAL: DO RESTART KE DARMIYAN EK KAM SE KAM WAQFA ─────────────
    //
    // Upar wale sab pehre theek hain, magar unhein sahi rehna PARTA hai. Ye
    // jaal us surat ke liye hai jab koi un se bach nikle: gateway ko uthne
    // mein ~20 second lagte hain, is liye us se tez aane wale restart usay
    // hamesha ke liye be-kaar kar dete hain — wo kabhi kisi turn ko poora
    // nahi kar pata, aur har chat par sirf "gateway shutting down" pohnchta
    // hai. Aisi kharabi ka pata bhi der se chalta hai, kyunki har hissa alag
    // alag bilkul theek nazar aata hai.
    //
    // Darkhwast girayi NAHI jati — us se ek asli key ki tabdeeli chup-chaap
    // zaya ho sakti thi. Usay qatar mein daal dete hain: waqfa poora hote hi
    // ek restart chalta hai jo beech ki saari darkhwaston ko ek saath poora
    // kar deta hai.
    const since = Date.now() - this._lastCredentialRestartAt;
    if (this._lastCredentialRestartAt && since < CREDENTIAL_RESTART_MIN_GAP_MS) {
      this._scheduleCredentialRestart(CREDENTIAL_RESTART_MIN_GAP_MS - since);
      console.log(
        `[Hermes] Gateway abhi ${Math.round(since / 1000)}s pehle restart hua — ye bounce qatar mein daal diya.`,
      );
      return { ok: true, restarted: false, deferred: true };
    }
    this._lastCredentialRestartAt = Date.now();

    // Hermes' own endpoint: it stops and respawns the gateway in the background,
    // which keeps the WhatsApp bridge parented the same way a manual restart does.
    const res = await this.apiFetch('/api/gateway/restart', { method: 'POST' });
    if (!res.ok) {
      // Restart hua hi nahi, is liye waqfe ka hisaab bhi wapas kar dete hain —
      // warna ek nakaam koshish agli asli koshish ko ek minute rok deti.
      this._lastCredentialRestartAt = 0;
      console.warn('[Hermes] Gateway restart after credential change failed:',
        res.status, (res.data && res.data.detail) || (res.data && res.data.error) || '');
      return { ok: false, restarted: false };
    }
    // The respawned gateway is a new process, so re-record ownership or app exit
    // would leave it (and its WhatsApp bridge) running.
    this._gatewayStartedByUs = true;
    setTimeout(() => this._recordOwnedProcesses(true), 6000);
    console.log('[Hermes] Gateway restarted to pick up new credentials.');
    return { ok: true, restarted: true };
  }

  /**
   * Ek bounce ko waqfa poora hone tak qatar mein rakhna.
   *
   * Ek waqt mein sirf EK timer. Beech mein aane wali har doosri darkhwast usi
   * ek intezaar mein sama jati hai — kyunki gateway ka restart har haal mein
   * poori .env dobara parhta hai, chahe darmiyan mein das keys badli hon ya ek.
   */
  _scheduleCredentialRestart(delayMs) {
    if (this._credentialRestartTimer) return;

    this._credentialRestartTimer = setTimeout(() => {
      this._credentialRestartTimer = null;
      if (this._stopping) return;
      this.restartGatewayForCredentialChange().catch((err) => {
        console.warn('[Hermes] Qatar mein para gateway bounce nakaam hua:', err.message);
      });
    }, Math.max(0, delayMs));

    // App band hone ke waqt ye timer Node ko zinda na rakhe.
    if (typeof this._credentialRestartTimer.unref === 'function') {
      this._credentialRestartTimer.unref();
    }
  }

  /**
   * Persist the gateway/bridge processes that appeared on our watch. A scan
   * spawns a shell, so the periodic caller is rate-limited; `force` is for the
   * moments that matter (gateway start, shutdown) where freshness beats cost.
   */
  _recordOwnedProcesses(force = false) {
    const now = Date.now();
    if (!force && this._lastOwnedScanAt && now - this._lastOwnedScanAt < OWNED_SCAN_MIN_INTERVAL_MS) return;
    this._lastOwnedScanAt = now;
    try {
      childRegistry.reconcileOwned(this._preexistingHermes);
    } catch (err) {
      console.warn('[Hermes] Could not record owned processes:', err.message);
    }
  }

  async stop() {
    this._stopping = true;
    this._stopStatusLoop();
    // Qatar mein para hua bounce ab be-maani hai — app hi ja rahi hai.
    if (this._credentialRestartTimer) {
      clearTimeout(this._credentialRestartTimer);
      this._credentialRestartTimer = null;
    }
    // Isi tarah Mobile Remote ki agli koshish. Bina ise hataye ek band hoti
    // hui app gateway ko dobara start karne ki koshish kar sakti hai — yani
    // theek wo orphan process jise ye sara shutdown code rokne ke liye hai.
    this._knockdeskPending = false;
    if (this._knockdeskRetryTimer) {
      clearTimeout(this._knockdeskRetryTimer);
      this._knockdeskRetryTimer = null;
    }
    // Ownership of the gateway is separate from ownership of the dashboard: a
    // dashboard we adopted can still be serving a gateway WE started (WhatsApp
    // pairing does exactly that). Stop it through Hermes' API while the
    // dashboard that answers it is up — a tree kill would never reach it, and
    // orphaning it leaves WhatsApp answering after KnockDesk is closed.
    if (this._gatewayStartedByUs || (!this.external && this.child)) {
      this._recordOwnedProcesses(true);   // last chance to catch a late bridge
      await this._stopGatewayOnShutdown();
    }
    // Never kill a dashboard we didn't start.
    if (this.external || !this.child) {
      this._setState('stopped');
      return;
    }
    const pid = this.child.pid;
    try {
      if (process.platform === 'win32' && pid) {
        // hermes.exe wraps a python process tree — kill the whole tree.
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        this.child.kill('SIGTERM');
      }
    } catch (err) {
      console.warn('[Hermes] stop error:', err.message);
    }
    this.child = null;
    this._setState('stopped');
  }

  // ── Narrow REST bridge for the renderer (adds the session token) ─────
  async apiFetch(apiPath, { method = 'GET', body = null } = {}) {
    if (!apiPath || !apiPath.startsWith('/api/')) {
      return { ok: false, status: 0, data: { error: 'Only /api/* paths are allowed' } };
    }
    if (method === 'POST' && apiPath.startsWith('/api/gateway/')) this._noteGatewayCommand(apiPath);
    const doFetch = async () => axios({
      url: `${this.baseUrl}${apiPath}`,
      method,
      data: body ?? undefined,
      timeout: 20000,
      headers: this.token ? { 'X-Hermes-Session-Token': this.token } : {},
      validateStatus: () => true,
    });
    try {
      let res = await doFetch();
      if (res.status === 401 || res.status === 403) {
        // Token rotated (dashboard restarted) — refresh once and retry.
        await this._fetchToken();
        res = await doFetch();
      }
      return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data };
    } catch (err) {
      return { ok: false, status: 0, data: { error: err.message } };
    }
  }

  // ── Connection info for the renderer's chat WebSocket ───────────────
  // Hermes' chat gateway (streaming tokens, thinking, tool calls) is a
  // WebSocket, not REST, so the renderer opens ws://…/api/ws?token=… itself.
  // We hand it the base URL + a live session token — the same token apiFetch
  // attaches, re-read on demand because it rotates when the dashboard
  // restarts. The renderer re-calls this on every (re)connect so a rotated
  // token is always picked up. (Same technique Hermes' own desktop app uses.)
  async getConnectionInfo() {
    if (!this.token) await this._fetchToken();
    return {
      ok: !!this.token,
      baseUrl: this.baseUrl,
      wsUrl: `${this.baseUrl.replace(/^http/, 'ws')}/api/ws`,
      token: this.token || null,
      state: this.state,
    };
  }
}

module.exports = { HermesManager };
// Compat: pre-rebrand main.jsc calls requestStonicPlatform()/ensureStonicPlatform().
HermesManager.prototype.requestStonicPlatform = HermesManager.prototype.requestKnockDeskPlatform;
HermesManager.prototype.ensureStonicPlatform = HermesManager.prototype.ensureKnockDeskPlatform;
