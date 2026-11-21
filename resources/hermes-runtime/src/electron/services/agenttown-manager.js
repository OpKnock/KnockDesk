// AgentTownManager — runs the standalone Agent Town (Next.js + Phaser) app as a
// separate local process and gives KnockDesk a narrow bridge to embed its UI.
//
// Design mirrors HermesManager: KnockDesk (1) spawns the Agent Town dev server as a
// sidecar, (2) probes readiness over HTTP, and (3) exposes its URL so the
// renderer can load the WHOLE Agent Town UI inside an Electron <webview>.
//
// IMPORTANT (current phase): this only brings the UI in. Agent Town is started
// with its default gateway (`ws://127.0.0.1:18789/`, Hermes' port) but the
// protocol wiring to Hermes is NOT done yet — the game simply renders and shows
// "disconnected" until we add a Hermes provider/bridge later. Nothing here
// touches the Agent Town source; we only pass env + spawn its own `npm run dev`.
//
// If a server is already running on the port (user started it by hand), we
// adopt it instead of spawning a second one and never kill it on exit.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const axios = require('axios');
// Aliased: this class has a method of the same name that delegates to it.
const { resolveHermesExe: resolveSharedHermesExe, hermesSpawnEnv } = require('./hermes-runtime');

const DEFAULT_PORT = parseInt(process.env.STONIC_AGENTTOWN_PORT || '3010', 10);
// Agent Town's default gateway is Hermes' port. Not connected yet — see header.
const DEFAULT_GATEWAY = process.env.STONIC_AGENTTOWN_GATEWAY || 'ws://127.0.0.1:18789/';
// Next.js dev first-compile can be slow; poll generously.
const READY_TIMEOUT_MS = 3 * 60 * 1000;
const READY_POLL_MS = 5000; // idle-throttled (was 1500)
// Agent Town used to hard-code 3010. Hermes' WhatsApp bridge (a SEPARATE
// process) also defaults to 127.0.0.1:3010, and having bound IPv4 first it
// shadows our dual-stack (`::`) Next.js server for every 127.0.0.1 request:
// the readiness probe (and the webview) hit the bridge's Express 404 instead
// of Agent Town, so we spin on "Booting server…" until the timeout. Scan a
// small range and take the first port that is actually ours — this is what
// stops the hang. Mirrors browser-manager's CDP-port scan (Adobe squats 9222).
const PORT_SCAN_START = DEFAULT_PORT;
const PORT_SCAN_END = DEFAULT_PORT + 20;

class AgentTownManager {
  constructor() {
    this.port = DEFAULT_PORT;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this.child = null;
    this.external = false;        // true when we adopted a server we did not spawn
    this.state = 'idle';          // idle | starting | ready | error | stopped
    this.error = null;
    this.dir = null;
    this.bundled = false;       // true when running the shipped agent-town-dist
    this.mainWindow = null;
    this._readyPoller = null;
    this._healthPoller = null;
    this._stopping = false;
    this._autoRestarts = 0;
    this._restarting = false;
    this._hermes = null;          // HermesManager, for the run API handshake
    this._runApiPoller = null;
    this._runApiWritten = false;
  }

  setWindow(win) { this.mainWindow = win; }

  /**
   * Hand over the HermesManager so seats can run on Hermes' own run API.
   *
   * Agent Town boots before Hermes has necessarily finished starting, so the
   * credentials cannot be passed as spawn env — they may not exist yet. Instead
   * we write them to a small JSON file the bridge re-reads as it works (see
   * agent-town-main/lib/hermes-run-api.ts), and keep trying in the background
   * until they land. Until then Agent Town runs on its CLI fallback, so nothing
   * is ever blocked waiting for this.
   */
  setHermesManager(hermes) {
    this._hermes = hermes;
    this._startRunApiWatch();
  }

  // Where the bridge looks for { url, key }. Kept next to the app's own data so
  // a packaged install has somewhere writable.
  runApiConfigPath() {
    const { app } = require('electron');
    const dir = app.getPath('userData');
    return path.join(dir, 'agent-town-hermes-api.json');
  }

  _startRunApiWatch() {
    if (this._runApiPoller || !this._hermes) return;
    const tick = async () => {
      this._runApiPoller = null;
      if (this._stopping) return;
      let done = false;
      try {
        const cfg = await this._hermes.ensureRunApi();
        if (cfg && cfg.key) {
          fs.writeFileSync(
            this.runApiConfigPath(),
            JSON.stringify({ url: cfg.url, key: cfg.key }),
            { encoding: 'utf8', mode: 0o600 },
          );
          if (!this._runApiWritten) {
            this._runApiWritten = true;
            console.log('[AgentTown] Seats will run on the Hermes run API at', cfg.url);
          }
          done = true;
        }
      } catch (err) {
        console.warn('[AgentTown] Run API handshake failed:', err.message);
      }
      // Keep checking after success too, but rarely: the gateway can be
      // restarted from Hermes' own UI, which rotates nothing but is worth
      // re-confirming so a stale file never strands us on the fallback.
      this._runApiPoller = setTimeout(tick, done ? 15 * 60_000 : 60_000); // idle-throttled (was 5min/15s)
    };
    this._runApiPoller = setTimeout(tick, 15_000); // idle-throttled (was 5s)
  }

  _stopRunApiWatch() {
    if (this._runApiPoller) {
      clearTimeout(this._runApiPoller);
      this._runApiPoller = null;
    }
  }

  // ── Locate the Agent Town server ──
  // Two shapes: the production bundle we ship (agent-town-dist/, built by
  // scripts/build-agent-town.js) and the dev source tree next to KnockDesk_main.
  // Returns { dir, bundled } or null.
  //
  // Dev keeps using the source tree so `next dev` hot reload still works. A
  // packaged app has no source tree — and no Node, no pnpm — so it must use the
  // bundle. Set STONIC_AGENTTOWN_BUNDLED=1 to exercise the shipped path in dev.
  resolveRuntime() {
    const bundledCandidates = [
      process.env.STONIC_AGENTTOWN_BUNDLED === '1' ? process.env.STONIC_AGENTTOWN_DIR : null,
      process.resourcesPath ? path.join(process.resourcesPath, 'agent-town-dist') : null,
      path.resolve(__dirname, '..', '..', 'agent-town-dist'),
    ];
    const findBundled = () => {
      for (const dir of bundledCandidates) {
        try {
          if (dir && fs.existsSync(path.join(dir, 'server.js'))) return { dir, bundled: true };
        } catch { /* ignore */ }
      }
      return null;
    };

    const sourceCandidates = [
      process.env.STONIC_AGENTTOWN_DIR,
      // electron/services → up 3 = workspace root ("KnockDesk Ai - AGI") → agent-town-main
      path.resolve(__dirname, '..', '..', '..', 'agent-town-main'),
    ];
    const findSource = () => {
      for (const dir of sourceCandidates) {
        try {
          if (dir && fs.existsSync(path.join(dir, 'package.json'))) return { dir, bundled: false };
        } catch { /* ignore */ }
      }
      return null;
    };

    let packaged = false;
    try { packaged = require('electron').app.isPackaged; } catch { /* not in main process */ }

    if (packaged || process.env.STONIC_AGENTTOWN_BUNDLED === '1') {
      return findBundled() || findSource();
    }
    if (process.env.STONIC_AGENTTOWN_DIR) return findSource() || findBundled();
    return findSource() || findBundled();
  }

  // Back-compat for callers that only want the path.
  resolveDir() {
    return this.resolveRuntime()?.dir ?? null;
  }

  // Resolve the Hermes CLI the bridge should spawn. Shared with HermesManager
  // so both always run the same Hermes — read-only, never installs/configures it.
  resolveHermesExe() {
    return resolveSharedHermesExe();
  }

  // The Electron-bundled Node (currently 22.11) is put first on PATH by the
  // app bootstrap. `tsx server.ts` then installs an ESM resolver which breaks
  // Next 16's Webpack/PostCSS virtual module URLs on Windows
  // (ERR_INVALID_URL_SCHEME, every CSS file returns 500). In development use
  // the user's normal Node installation explicitly; the packaged path below
  // never uses tsx and continues to run the prebuilt server with Electron Node.
  //
  // Platform split: the win32 list is the original one, unchanged. macOS/Linux
  // needed their own — %ProgramFiles%/%LOCALAPPDATA% simply do not exist there,
  // so the list came back empty and start() reported "development runtime is
  // unavailable" even with Node installed. Only the dev path uses this; a
  // packaged app runs the bundle on Electron's own Node on every platform.
  resolveDevNodeExe() {
    const candidates = [process.env.STONIC_AGENTTOWN_NODE];
    if (process.platform === 'win32') {
      candidates.push(
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs', 'node.exe') : null,
        process.env.ProgramW6432 ? path.join(process.env.ProgramW6432, 'nodejs', 'node.exe') : null,
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe') : null,
      );
    } else {
      candidates.push(
        // nvm exports NVM_BIN for the active version; honour it before the
        // system copies so a dev on nvm gets the Node they actually use.
        process.env.NVM_BIN ? path.join(process.env.NVM_BIN, 'node') : null,
        '/opt/homebrew/bin/node',   // Apple Silicon Homebrew
        '/usr/local/bin/node',      // Intel Homebrew + nodejs.org .pkg installer
        '/usr/bin/node',            // distro packages
      );
    }
    for (const candidate of candidates) {
      try {
        if (candidate && fs.existsSync(candidate)) return candidate;
      } catch { /* try the next candidate */ }
    }
    // Last resort on posix: a GUI-launched Electron app inherits launchd's bare
    // PATH, not the user's shell PATH, so an nvm/asdf/fnm Node is invisible to
    // the fixed paths above. Ask a login+interactive shell where `node` is —
    // that is the only thing which sources the rc file installing those
    // managers. Timeboxed so a slow or wedged rc can never block startup.
    if (process.platform !== 'win32') {
      try {
        const { execFileSync } = require('child_process');
        const shell = process.env.SHELL || '/bin/zsh';
        const found = execFileSync(shell, ['-lic', 'command -v node'], {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim().split('\n').pop().trim();
        if (found && fs.existsSync(found)) return found;
      } catch { /* no shell-resolved node either */ }
    }
    return null;
  }

  // Synchronously kill a process tree (Windows) / process (posix). Used on
  // shutdown so nothing is left running in the background.
  _killTreeSync(pid) {
    if (!pid) return;
    try {
      const { execFileSync } = require('child_process');
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 });
      } else {
        try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
      }
    } catch { /* already gone */ }
  }

  // Free our port + drop the stale Next dev lock before spawning. Handles the
  // case where a previous run (or a crash) left a half-dead worker holding the
  // turbopack cache — kill the port owner, then delete with retries.
  _prepareCleanStart() {
    try {
      if (process.platform === 'win32') {
        const { execSync } = require('child_process');
        // Kill whatever still listens on our port, plus any stray agent-town
        // dev server node processes from a previous unclean shutdown.
        execSync(
          'powershell -NoProfile -Command "' +
            `$c=Get-NetTCPConnection -LocalPort ${this.port} -State Listen -EA SilentlyContinue;` +
            'if($c){$c.OwningProcess|Select-Object -Unique|ForEach-Object{Stop-Process -Id $_ -Force -EA SilentlyContinue}};' +
            "Get-CimInstance Win32_Process -Filter \\\"Name='node.exe'\\\" -EA SilentlyContinue|" +
            "Where-Object{$_.CommandLine -like '*agent-town-main*server.ts*'}|" +
            'ForEach-Object{Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue}"',
          { stdio: 'ignore', timeout: 10000 }
        );
      } else {
        // Same two kills for macOS/Linux. Each is its own try: an empty lsof
        // makes the port sweep exit non-zero, and that must not skip the
        // stray-server sweep behind it.
        const { execSync } = require('child_process');
        try {
          execSync(
            `pids=$(lsof -ti tcp:${this.port} -sTCP:LISTEN); [ -n "$pids" ] && kill -9 $pids`,
            { stdio: 'ignore', timeout: 10000, shell: '/bin/sh' }
          );
        } catch { /* nothing was listening */ }
        try {
          execSync(
            "pkill -f 'agent-town-main.*server\\.ts'",
            { stdio: 'ignore', timeout: 10000, shell: '/bin/sh' }
          );
        } catch { /* no stray dev server */ }
      }
    } catch { /* best effort */ }

    const devDir = path.join(this.dir, '.next', 'dev');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (!fs.existsSync(devDir)) break;
        fs.rmSync(devDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
        console.log('[AgentTown] Cleared stale Next dev lock');
        break;
      } catch (err) {
        if (attempt === 1) console.warn('[AgentTown] Could not fully clear dev lock:', err.message);
      }
    }
  }

  getState() {
    return {
      state: this.state,
      error: this.error,
      url: this.baseUrl,
      port: this.port,
      external: this.external,
      dir: this.dir,
      bundled: this.bundled,
    };
  }

  _setState(state, error = null) {
    this.state = state;
    this.error = error;
    this._broadcast();
  }

  _broadcast() {
    try {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('agenttown-state', this.getState());
      }
    } catch { /* window may be closing */ }
  }

  // Probe a specific port on 127.0.0.1 — the same interface the webview loads,
  // so a 200 here guarantees the embedded UI will reach the same server.
  async _probePort(port, timeoutMs = 2500) {
    const res = await axios.get(`http://127.0.0.1:${port}/`, {
      timeout: timeoutMs,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    return res.status;
  }

  async _probe(timeoutMs = 2500) {
    // A response in the 2xx/3xx range means Next.js is actually serving the
    // page. A 4xx/5xx (e.g. a bare "Cannot GET /") means SOMETHING is
    // listening on the port but the app isn't ready to render yet — during a
    // restart this window is real: the TCP port can be reopened by a fresh
    // child, or briefly held by the dying old one, before Next's request
    // handler is actually wired up. Treating that as "ready" used to freeze
    // the embedded webview on that error text with no further self-heal,
    // because the periodic health-watch below reused this same check and so
    // considered the broken page healthy forever. Throwing here instead keeps
    // both the initial readiness poll and the health-watch retrying until a
    // real page comes back.
    return this._probePort(this.port, timeoutMs);
  }

  // Is `port` bindable on 127.0.0.1 right now? We bind-and-release only to test
  // freeness; server.ts binds it for real a moment later. Testing on the IPv4
  // loopback (not `::`) is deliberate: that is the interface the probe and the
  // webview use, so a "free" verdict here means our server won't be shadowed by
  // another IPv4 listener (e.g. the WhatsApp bridge on the old default 3010).
  _isPortFree(port) {
    return new Promise((resolve) => {
      const tester = net.createServer();
      tester.once('error', () => resolve(false));
      tester.listen(port, '127.0.0.1', () => {
        tester.close(() => resolve(true));
      });
    });
  }

  // Pick the port Agent Town should use: the first free port at/above the
  // default, OR an existing port already serving a real Agent Town (adopt it).
  // A port held by a non-Agent-Town service (the WhatsApp bridge answers 404,
  // not 2xx) is skipped rather than adopted or killed. Returns { port, adopt }
  // or null when the whole range is exhausted.
  async _resolvePort() {
    for (let port = PORT_SCAN_START; port <= PORT_SCAN_END; port++) {
      if (await this._isPortFree(port)) {
        return { port, adopt: false };
      }
      try {
        await this._probePort(port); // 2xx/3xx only — a live Agent Town
        return { port, adopt: true };
      } catch {
        console.warn(`[AgentTown] Port ${port} is held by another service (likely Hermes' WhatsApp bridge); scanning upward for a free port.`);
      }
    }
    return null;
  }

  _stopHealthWatch() {
    if (this._healthPoller) {
      clearTimeout(this._healthPoller);
      this._healthPoller = null;
    }
  }

  // An adopted server can disappear without emitting a child-process `exit`
  // event. Verify the HTTP handler as well as the open port and recover it;
  // otherwise the webview stays on Loading World forever after an old sidecar
  // dies or a Next compiler wedges.
  _startHealthWatch() {
    this._stopHealthWatch();
    // A restart kills the server and every task running on its CLI fallback, so
    // one missed probe must never be enough. Next can stall for a few seconds
    // under load; only a sustained outage is a real one.
    const FAILURES_BEFORE_RESTART = 3;
    let consecutiveFailures = 0;
    const tick = async () => {
      if (this._stopping || this.state !== 'ready') return;
      try {
        await this._probe(5000);
        consecutiveFailures = 0;
      } catch {
        consecutiveFailures++;
        if (consecutiveFailures < FAILURES_BEFORE_RESTART) {
          console.warn(
            `[AgentTown] Health probe failed (${consecutiveFailures}/${FAILURES_BEFORE_RESTART}); retrying.`
          );
        } else {
          console.warn('[AgentTown] Ready server stopped responding; restarting it.');
          this._setState('idle');
          this.external = false;
          this.child = null;
          void this.restart();
          return;
        }
      }
      this._healthPoller = setTimeout(tick, 60_000);
      if (this._healthPoller && this._healthPoller.unref) this._healthPoller.unref();
    };
    this._healthPoller = setTimeout(tick, 60_000); // idle-throttled (was 10s)
    if (this._healthPoller && this._healthPoller.unref) this._healthPoller.unref();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────
  async start() {
    if (this.state === 'starting') return this.getState();
    if (this.state === 'ready') {
      try {
        await this._probe(1500);
        return this.getState();
      } catch {
        // Do not trust an old adopted listener merely because it still has a
        // state flag. Fall through to a clean restart below.
        this.state = 'idle';
        this.external = false;
        this.child = null;
      }
    }
    this._stopping = false;
    this._setState('starting');

    // 1. Resolve the port BEFORE anything else. This both adopts a live Agent
    //    Town and, crucially, steps past the WhatsApp bridge that squats the
    //    old fixed default (3010) — the actual cause of the "Booting server…"
    //    hang. Everything downstream (clean-start kill, spawn env, probe) then
    //    targets this resolved port, so we never fight the bridge for 3010 nor
    //    accidentally kill it.
    const resolved = await this._resolvePort();
    if (!resolved) {
      this._setState('error', `No free port for Agent Town in ${PORT_SCAN_START}-${PORT_SCAN_END}.`);
      return this.getState();
    }
    this.port = resolved.port;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    if (resolved.adopt) {
      this.external = true;
      this._setState('ready');
      this._startHealthWatch();
      console.log('[AgentTown] Adopted already-running server at', this.baseUrl);
      return this.getState();
    }

    // 2. Locate the server — the shipped bundle, or the dev source tree.
    const runtime = this.resolveRuntime();
    if (!runtime) {
      this._setState('error', 'Agent Town not found (expected bundled "agent-town-dist" or sibling "agent-town-main").');
      return this.getState();
    }
    this.dir = runtime.dir;
    this.bundled = runtime.bundled;
    if (!fs.existsSync(path.join(this.dir, 'node_modules'))) {
      this._setState('error', this.bundled
        ? 'Bundled Agent Town is incomplete (no node_modules). Rebuild with `npm run build:agent-town -- --force`.'
        : 'Agent Town dependencies not installed. Run `pnpm install` in agent-town-main.');
      return this.getState();
    }

    // 2.5 Clean start. We only reach here when the HTTP probe found nothing
    //     serving, so free our port (in case a previous instance is still
    //     bound / half-dead) and drop the stale Next dev lock — otherwise
    //     `next dev` fails with "Unable to acquire lock". `fs.rmSync` alone
    //     hits EPERM when a lingering worker still holds a turbopack cache
    //     file, so we kill the port owner first and retry the delete.
    this._prepareCleanStart();

    // 3. Spawn the server.
    //    Provider = hermes: Agent Town's own hermes-bridge spawns `hermes -z`
    //    per task, so seats run on the local Hermes Agent (see the bridge in
    //    agent-town-main/lib/hermes-bridge.ts). Hermes itself is never modified.
    this.external = false;
    const hermesExe = this.resolveHermesExe();
    // hermesSpawnEnv, not process.env: the bridge's `hermes -z` children have
    // to inherit the same approval bypass every other Hermes we start gets.
    const env = hermesSpawnEnv({
      PORT: String(this.port),
      GATEWAY_URL: DEFAULT_GATEWAY,
      AGENT_PROVIDER: 'hermes',
      HERMES_EXE: hermesExe,
      // Where the bridge picks up Hermes' run API credentials once they exist.
      // The file may not be written yet at spawn time — that is expected, and
      // the bridge simply uses its CLI engine until it appears.
      HERMES_API_CONFIG_FILE: this.runApiConfigPath(),
    });

    try {
      if (this.bundled) {
        // Run the prebuilt server on Electron's OWN Node (ELECTRON_RUN_AS_NODE),
        // so a customer needs no Node install. process.execPath is the KnockDesk
        // binary itself; with that flag it behaves as a plain node runtime.
        const entry = path.join(this.dir, 'server.js');
        console.log('[AgentTown] Starting bundled server', entry, 'on port', this.port, '(hermes:', hermesExe + ')');
        this.child = spawn(process.execPath, [entry], {
          cwd: this.dir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production' },
        });
      } else {
        const nodeExe = this.resolveDevNodeExe();
        const tsxCli = path.join(this.dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
        if (!nodeExe || !fs.existsSync(tsxCli)) {
          this._setState('error', process.platform === 'win32'
            ? 'Agent Town development runtime is unavailable. Install Node.js or set STONIC_AGENTTOWN_NODE to node.exe.'
            : 'Agent Town development runtime is unavailable. Install Node.js or set STONIC_AGENTTOWN_NODE to the node binary.');
          return this.getState();
        }
        console.log('[AgentTown] Spawning dev server in', this.dir, 'on port', this.port, '(node:', nodeExe, '; hermes:', hermesExe + ')');
        this.child = spawn(nodeExe, [tsxCli, 'server.ts'], {
          cwd: this.dir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          // posix only: make the child its own process-group leader so the
          // `process.kill(-pid)` in _killTreeSync reaps the whole
          // tsx → next → esbuild tree, the way `taskkill /T` does on Windows.
          // Without it that call finds no such group, falls back to killing the
          // direct child alone, and the workers orphan holding the dev lock.
          detached: process.platform !== 'win32',
          env: { ...env, NODE_ENV: 'development', BROWSER: 'none' },
        });
      }
    } catch (err) {
      this._setState('error', `Failed to launch Agent Town: ${err.message}`);
      return this.getState();
    }

    const logLine = (buf) => {
      const line = String(buf).trim();
      if (line) console.log('[AgentTown]', line.slice(0, 400));
    };
    this.child.stdout?.on('data', logLine);
    this.child.stderr?.on('data', logLine);

    this.child.on('exit', (code) => {
      console.log('[AgentTown] dev server exited with code', code);
      this.child = null;
      if (!this._stopping) {
        if (this._autoRestarts < 1) {
          this._autoRestarts++;
          console.warn(`[AgentTown] server exited — automatic restart ${this._autoRestarts}/1...`);
          this.state = 'idle';
          this.external = false;
          this._broadcast();
          setTimeout(() => this.start().catch(() => { /* reflected via state */ }), 8000); // idle backoff (was 2000)
        } else {
          this._setState('error', `Agent Town server exited unexpectedly (code ${code})`);
        }
      }
    });
    this.child.on('error', (err) => {
      this.child = null;
      this._setState('error', `Agent Town launch error: ${err.message}`);
    });

    // 4. Poll readiness (dev first-compile can take a while).
    const deadline = Date.now() + READY_TIMEOUT_MS;
    await new Promise((resolve) => {
      const tick = async () => {
        if (this._stopping || this.state === 'error') return resolve();
        try {
          await this._probe();
          this._autoRestarts = 0;
          this._setState('ready');
          this._startHealthWatch();
          console.log('[AgentTown] Server ready at', this.baseUrl);
          return resolve();
        } catch {
          if (Date.now() > deadline) {
            this._setState('error', 'Agent Town server did not become ready in time.');
            return resolve();
          }
          this._readyPoller = setTimeout(tick, READY_POLL_MS);
        }
      };
      tick();
    });
    return this.getState();
  }

  // `skipPortSweep` is for the app-quit path. The sweep below is synchronous, so
  // its runtime is added directly to the user's wait between "the window closed"
  // and "the process is gone" — measured at ~3.5s, the single biggest cost of
  // quitting. It is also redundant there: the pre-spawn cleanup in start() frees
  // this port and kills stray agent-town dev servers before every launch, so a
  // grandchild that somehow survived the tree kill is cleared then instead.
  async stop({ skipPortSweep = false } = {}) {
    this._stopping = true;
    if (this._readyPoller) { clearTimeout(this._readyPoller); this._readyPoller = null; }
    this._stopHealthWatch();
    this._stopRunApiWatch();
    // Never kill a server we didn't start.
    if (this.external || !this.child) {
      this._setState('stopped');
      return;
    }
    const pid = this.child.pid;
    // Synchronous tree-kill so the whole npm → node → tsx → next dev + turbopack
    // worker tree (and any in-flight `hermes -z` children) is dead BEFORE the app
    // exits — otherwise they orphan and hold the Next dev lock on next launch.
    this._killTreeSync(pid);
    // Belt-and-braces: also free the port in case a grandchild rebound it.
    if (!skipPortSweep) {
      try {
        if (process.platform === 'win32') {
          const { execSync } = require('child_process');
          execSync(
            'powershell -NoProfile -Command "' +
              `$c=Get-NetTCPConnection -LocalPort ${this.port} -State Listen -EA SilentlyContinue;` +
              'if($c){$c.OwningProcess|Select-Object -Unique|ForEach-Object{Stop-Process -Id $_ -Force -EA SilentlyContinue}}"',
            { stdio: 'ignore', timeout: 8000 }
          );
        } else {
          const { execSync } = require('child_process');
          execSync(
            `pids=$(lsof -ti tcp:${this.port} -sTCP:LISTEN); [ -n "$pids" ] && kill -9 $pids`,
            { stdio: 'ignore', timeout: 8000, shell: '/bin/sh' }
          );
        }
      } catch { /* best effort */ }
    }
    this.child = null;
    this._setState('stopped');
  }

  async restart() {
    if (this._restarting) return this.getState();
    this._restarting = true;
    try {
      this._stopHealthWatch();
      if (this.child && !this.external) {
        await this.stop();
      } else {
        this._stopping = false;
        this.child = null;
        this.external = false;
        this._setState('idle');
      }
      this._stopping = false;
      return await this.start();
    } finally {
      this._restarting = false;
    }
  }
}

module.exports = { AgentTownManager };
