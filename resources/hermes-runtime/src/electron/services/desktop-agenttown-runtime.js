'use strict';

/**
 * Dependency-free launcher for the shipped AgentTown standalone server.
 * It intentionally does not claim to establish a Hermes protocol connection:
 * that integration must be implemented by AgentTown itself.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { hermesSpawnEnv, resolveHermesExe } = require('./hermes-runtime');

const DEFAULT_PORT = Number.parseInt(process.env.KNOCKDESK_AGENTTOWN_PORT || process.env.STONIC_AGENTTOWN_PORT || '3010', 10);

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


function isAgentTownHtml(contentType, html) {
  return String(contentType).includes('text/html') && /<html[\s>]/i.test(html) && html.includes('/_next/');
}

function probe(url, timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs, headers: { accept: 'text/html' } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        if (size >= 128 * 1024) return;
        const remaining = 128 * 1024 - size;
        const sample = chunk.subarray(0, remaining);
        chunks.push(sample);
        size += sample.length;
      });
      res.on('end', () => {
        if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 400) {
          reject(new Error('AgentTown returned HTTP ' + res.statusCode));
          return;
        }
        const type = String(res.headers['content-type'] || '');
        const html = Buffer.concat(chunks).toString('utf8');
        if (!isAgentTownHtml(type, html)) {
          reject(new Error('The listener is not an AgentTown Next.js page.'));
          return;
        }
        resolve(res.statusCode);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('AgentTown request timed out.')));
    req.once('error', reject);
  });
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

class DesktopAgentTownRuntime {
  constructor() {
    this.port = Number.isInteger(DEFAULT_PORT) && DEFAULT_PORT > 0 && DEFAULT_PORT < 65536
      ? DEFAULT_PORT : 3010;
    this.baseUrl = 'http://127.0.0.1:' + this.port;
    this.state = 'idle';
    this.error = null;
    this.external = false;
    this.bundled = true;
    this.dir = null;
    this.child = null;
    this.mainWindow = null;
    this.stopping = false;
    this.startPromise = null;
  }

  getState() {
    return {
      state: this.state,
      error: this.error,
      url: this.baseUrl,
      port: this.port,
      external: this.external,
      bundled: this.bundled,
    };
  }

  _broadcast() {
    try {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('agenttown-state', this.getState());
      }
    } catch (error) {
      console.warn('[AgentTown] Could not notify renderer:', error.message);
    }
  }

  _setState(state, error = null) {
    this.state = state;
    this.error = error ? String(error) : null;
    this._broadcast();
  }

  _resolveDir() {
    const candidates = [
      process.env.KNOCKDESK_AGENTTOWN_DIR,
      process.env.STONIC_AGENTTOWN_DIR,
      process.resourcesPath ? path.join(process.resourcesPath, 'agent-town-dist') : null,
      path.resolve(__dirname, '..', '..', 'resources', 'agent-town-dist'),
      path.resolve(__dirname, '..', '..', '..', '..', '..', 'agent-town-dist'),
    ];
    for (const candidate of candidates) {
      try {
        if (candidate && fs.existsSync(path.join(candidate, 'server.js'))) return path.resolve(candidate);
      } catch {
        // Try the next known app layout.
      }
    }
    return null;
  }

  start() {
    if (this.state === 'ready' || this.state === 'starting') return Promise.resolve(this.getState());
    this.stopping = false;
    this._setState('starting');
    // A detached background failure must not leave the runtime stuck at
    // "starting" with a permanently rejected promise. Keep launch non-blocking,
    // report unexpected failures, and allow a later call to retry.
    const pendingStart = this._startBackground().catch((error) => {
      if (!this.stopping) {
        const message = error instanceof Error ? error.message : String(error);
        this._setState('error', 'AgentTown startup failed: ' + message);
      }
      if (this.startPromise === pendingStart) this.startPromise = null;
    });
    this.startPromise = pendingStart;
    return Promise.resolve(this.getState());
  }

  async _startBackground() {
    // Adopt only a healthy HTTP server; never terminate a process we didn't spawn.
    const adopted = await probe(this.baseUrl).catch(() => null);
    if (this.stopping) {
      this.startPromise = null;
      return;
    }
    if (adopted) {
      this.external = true;
      this._setState('ready');
      return;
    }

    this.dir = this._resolveDir();
    if (!this.dir) {
      this._setState('error', 'AgentTown bundle is missing. Reinstall the complete KnockDesk runtime.');
      this.startPromise = null;
      return;
    }

    // The Hermes WhatsApp bridge may also bind port 3010. Select a free loopback
    // port rather than repeatedly spawning a server that can never listen.
    let freePort = null;
    for (let offset = 0; offset < 32; offset += 1) {
      if (this.stopping) {
        this.startPromise = null;
        return;
      }
      const candidate = this.port + offset;
      if (candidate > 65535) break;
      const available = await isPortAvailable(candidate);
      if (this.stopping) {
        this.startPromise = null;
        return;
      }
      if (available) {
        freePort = candidate;
        break;
      }
    }
    if (this.stopping) {
      this.startPromise = null;
      return;
    }
    if (freePort === null) {
      this._setState('error', 'No free loopback port was found for AgentTown.');
      this.startPromise = null;
      return;
    }
    this.port = freePort;
    this.baseUrl = 'http://127.0.0.1:' + freePort;
    this._broadcast();

    // The shipped portable app can run its bundled Next server on Electron's
    // own Node runtime. No separate Node installation is needed in production.
    const hermesExe = resolveHermesExe();
    const env = hermesSpawnEnv({
      PORT: String(this.port),
      HOSTNAME: '127.0.0.1',
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      GATEWAY_URL: process.env.STONIC_AGENTTOWN_GATEWAY || 'ws://127.0.0.1:18789/',
      AGENT_PROVIDER: 'hermes',
      HERMES_EXE: hermesExe,
    });

    try {
      this.child = spawn(process.execPath, [path.join(this.dir, 'server.js')], {
        cwd: this.dir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production' },
      });
    } catch (error) {
      this._setState('error', 'Could not start AgentTown: ' + error.message);
      this.startPromise = null;
      return;
    }

    const log = (chunk) => {
      const line = String(chunk).trim();
      if (line) console.log('[AgentTown]', line.slice(0, 300));
    };
    this.child.stdout?.on('data', log);
    this.child.stderr?.on('data', log);
    let launchError = null;
    this.child.once('error', (error) => { launchError = error; });
    this.child.once('exit', (code, signal) => {
      if (this.stopping) return;
      if (this.state === 'ready') {
        this._setState('error', 'AgentTown stopped unexpectedly.');
      } else {
        this._setState('error', launchError
          ? 'Could not start AgentTown: ' + launchError.message
          : 'AgentTown exited before becoming ready (' + (signal || code) + ').');
      }
    });

    const deadline = Date.now() + 180000;
    while (!this.stopping && Date.now() < deadline) {
      if (launchError || (this.child && this.child.exitCode !== null)) break;
      const ready = await probe(this.baseUrl).catch(() => null);
      if (this.stopping) {
        this.startPromise = null;
        return;
      }
      if (ready) {
        this.external = false;
        this._setState('ready');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!this.stopping && this.state === 'starting') {
      this._setState('error', launchError
        ? 'Could not start AgentTown: ' + launchError.message
        : 'Timed out waiting for AgentTown on ' + this.baseUrl + '.');
    }
    this.startPromise = null;
  }

  async stop() {
    this.stopping = true;
    const ownedChild = this.child && !this.external ? this.child : null;
    const pendingStart = this.startPromise;
    await Promise.allSettled([
      stopOwnedChild(ownedChild),
      pendingStart,
    ].filter(Boolean));
    this.child = null;
    if (!this.external) this._setState('stopped');
  }
}

module.exports = { DesktopAgentTownRuntime, isAgentTownHtml };
