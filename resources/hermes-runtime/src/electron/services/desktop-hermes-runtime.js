'use strict';

/**
 * Small, dependency-free Hermes controller for the source-owned KnockDesk UI.
 * Uses Node built-ins only, so a source checkout does not require the packaged
 * app's separate Axios/vendor dependency tree just to render the desktop shell.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { resolveHermesExe, hermesSpawnEnv } = require('./hermes-runtime');

const DEFAULT_PORT = Number.parseInt(
  process.env.KNOCKDESK_HERMES_PORT || process.env.STONIC_HERMES_PORT || '9119',
  10,
);
const STARTUP_TIMEOUT_MS = 4 * 60 * 1000;
const POLL_INTERVAL_MS = 1500;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function stopOwnedChild(child, timeoutMs = 2500) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener('exit', finish);
      resolve();
    };
    child.once('exit', finish);
    timer = setTimeout(() => {
      try {
        if (child.exitCode === null) child.kill();
      } catch {
        // The OS may already have removed the process.
      }
      finish();
    }, timeoutMs);
    try {
      const sent = child.kill();
      if (!sent && child.exitCode !== null) finish();
    } catch {
      finish();
    }
  });
}

function request(url, timeoutMs = 1800) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs, headers: { accept: 'application/json' } }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('Hermes response exceeded the 1 MiB safety limit.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
          reject(new Error('Hermes returned HTTP ' + res.statusCode));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Hermes status response was not valid JSON.'));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Hermes request timed out.')));
    req.once('error', reject);
  });
}

class DesktopHermesRuntime {
  constructor() {
    this.port = Number.isInteger(DEFAULT_PORT) && DEFAULT_PORT > 0 && DEFAULT_PORT < 65536
      ? DEFAULT_PORT : 9119;
    this.baseUrl = 'http://127.0.0.1:' + this.port;
    this.state = 'idle';
    this.error = null;
    this.external = false;
    this.lastStatus = null;
    this.mainWindow = null;
    this.child = null;
    this.childError = null;
    this.stopping = false;
    this.startPromise = null;
    this.healthTimer = null;
    this.memoryChildren = new Set();
  }

  getHermesHome() {
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      return path.join(localAppData, 'hermes');
    }
    return path.join(os.homedir(), '.hermes');
  }

  getState() {
    return {
      state: this.state,
      error: this.error,
      url: this.baseUrl,
      port: this.port,
      external: this.external,
      status: this.lastStatus,
      knockdeskReady: false,
      knockdeskPending: this.state === 'starting',
      knockdeskError: null,
    };
  }

  _broadcast() {
    try {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('hermes-state', this.getState());
      }
    } catch (error) {
      console.warn('[KnockDesk runtime] Could not notify renderer:', error.message);
    }
  }

  _setState(state, error = null) {
    this.state = state;
    this.error = error ? String(error) : null;
    this._broadcast();
  }

  async _probe() {
    return request(this.baseUrl + '/api/status');
  }

  start() {
    if (this.state === 'ready' || this.state === 'starting') {
      return Promise.resolve(this.getState());
    }
    this.stopping = false;
    this.childError = null;
    this._setState('starting');
    // Keep startup non-blocking, but turn unexpected background failures into
    // an observable error state. Otherwise a rejected task can leave the UI
    // stuck at "starting" and future retries short-circuit forever.
    const pendingStart = this._startBackground().catch((error) => {
      if (!this.stopping) {
        const message = error instanceof Error ? error.message : String(error);
        this._setState('error', 'Hermes startup failed: ' + message);
      }
      if (this.startPromise === pendingStart) this.startPromise = null;
    });
    this.startPromise = pendingStart;
    return Promise.resolve(this.getState());
  }

  async _startBackground() {
    const firstProbe = await this._probe().catch(() => null);
    if (this.stopping) {
      this.startPromise = null;
      return;
    }
    if (firstProbe) {
      this.external = true;
      this.lastStatus = firstProbe;
      this._setState('ready');
      this._startHealthWatch();
      return;
    }

    this.external = false;
    const exe = resolveHermesExe();
    console.log('[KnockDesk runtime] Starting Hermes dashboard via:', exe);
    try {
      this.child = spawn(exe, ['dashboard', '--no-open'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: os.homedir(),
        env: hermesSpawnEnv(),
      });
    } catch (error) {
      this._setState('error', 'Could not launch Hermes: ' + error.message);
      this.startPromise = null;
      return;
    }

    const log = (chunk) => {
      const line = String(chunk).trim();
      if (line) console.log('[Hermes]', line.slice(0, 300));
    };
    this.child.stdout?.on('data', log);
    this.child.stderr?.on('data', log);
    this.child.once('error', (error) => {
      this.childError = error;
      if (!this.stopping && this.state !== 'ready') {
        this._setState('error', 'Hermes could not start: ' + error.message);
      }
    });
    this.child.once('exit', (code, signal) => {
      if (this.stopping) return;
      if (this.state !== 'ready') {
        this._setState('error', 'Hermes exited before becoming ready (' +
          (signal ? 'signal ' + signal : 'code ' + code) + '). Check that Hermes is installed.');
      } else {
        this._setState('error', 'Hermes dashboard stopped unexpectedly.');
      }
    });

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (!this.stopping && Date.now() < deadline) {
      if (this.childError) break;
      if (this.child && this.child.exitCode !== null) break;
      const status = await this._probe().catch(() => null);
      if (this.stopping) {
        this.startPromise = null;
        return;
      }
      if (status) {
        this.lastStatus = status;
        this._setState('ready');
        this._startHealthWatch();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    if (!this.stopping && this.state === 'starting') {
      this._setState('error', this.childError
        ? 'Hermes could not start: ' + this.childError.message
        : 'Timed out waiting for Hermes on ' + this.baseUrl +
          '. Verify the Hermes installation and runtime dependencies.');
    }
    this.startPromise = null;
  }

  _startHealthWatch() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(async () => {
      if (this.stopping || this.state !== 'ready') return;
      const status = await this._probe().catch(() => null);
      if (!status) {
        this._setState('error', 'Hermes is no longer responding at ' + this.baseUrl);
        return;
      }
      this.lastStatus = status;
      this._broadcast();
    }, 15000);
    this.healthTimer.unref?.();
  }

  readMemoryFiles() {
    const memoriesDir = path.join(this.getHermesHome(), 'memories');
    const readOne = (name) => {
      try {
        return fs.readFileSync(path.join(memoriesDir, name), 'utf8').trim();
      } catch {
        return '';
      }
    };
    const memory = readOne('MEMORY.md');
    const user = readOne('USER.md');
    return { available: Boolean(memory || user), memory, user };
  }

  memoryRequest(instruction) {
    if (this.stopping) return Promise.resolve({ ok: false, error: 'KnockDesk is shutting down.' });
    const clean = String(instruction || '').trim().slice(0, 1500);
    if (!clean) return Promise.resolve({ ok: false, error: 'Enter a memory instruction first.' });
    if (this.state !== 'ready') {
      return Promise.resolve({ ok: false, error: 'Start the Hermes runtime before updating memory.' });
    }

    const prompt =
      '[Memory request via KnockDesk app] The user said: "' + clean + '". ' +
      'Please evaluate this request and update their memory through your normal memory tools and policies.';
    const exe = resolveHermesExe();
    return new Promise((resolve) => {
      let child;
      let output = '';
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try { child?.kill(); } catch { /* process already exited */ }
        finish({ ok: false, error: 'Hermes took longer than 180 seconds. Please try again.' });
      }, 180000);

      try {
        child = spawn(exe, ['-z', prompt], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: os.homedir(),
          env: hermesSpawnEnv(),
        });
        this.memoryChildren.add(child);
      } catch (error) {
        finish({ ok: false, error: 'Could not launch Hermes: ' + error.message });
        return;
      }
      const collect = (chunk) => {
        if (output.length < 128 * 1024) output += String(chunk).slice(0, 128 * 1024 - output.length);
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.once('error', (error) => {
        this.memoryChildren.delete(child);
        finish({ ok: false, error: 'Hermes launch error: ' + error.message });
      });
      child.once('exit', (code) => {
        this.memoryChildren.delete(child);
        const summary = output.trim().split(/\r?\n/).filter(Boolean).pop() || 'No response from Hermes.';
        finish(code === 0
          ? { ok: true, message: summary.slice(0, 500) }
          : { ok: false, error: 'Hermes exited with code ' + code + ': ' + summary.slice(0, 300) });
      });
    });
  }

  async stop() {
    this.stopping = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;

    // Do not kill a service merely adopted from the user's existing session.
    const serverChild = this.child && !this.external ? this.child : null;
    const memoryChildren = [...this.memoryChildren];
    const pendingStart = this.startPromise;
    await Promise.allSettled([
      stopOwnedChild(serverChild),
      ...memoryChildren.map((child) => stopOwnedChild(child)),
      pendingStart,
    ].filter(Boolean));

    this.child = null;
    this.memoryChildren.clear();
    this._setState('stopped');
  }
}

module.exports = { DesktopHermesRuntime };
