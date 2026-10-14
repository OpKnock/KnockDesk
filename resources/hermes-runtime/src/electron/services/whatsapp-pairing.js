// WhatsApp pairing for the embedded (and unmodified) Hermes gateway.
//
// Hermes' own `hermes whatsapp` command cannot be driven from Electron: it is
// interactive, prompting for the mode, the phone number, and re-pair
// confirmation through `input()` (hermes_cli/main.py). What that command
// eventually *does*, though, is a single line:
//
//     node scripts/whatsapp-bridge/bridge.js --pair-only --session <dir>
//
// ...and that we can run ourselves, exactly as Hermes runs it. In `--pair-only`
// mode the bridge opens a Baileys socket, prints a QR code to stdout, waits for
// the scan, writes `creds.json` into the session directory and exits 0.
//
// The QR arrives as unicode half-blocks (qrcode-terminal's `small` mode — no
// ANSI colour), which is why the renderer can paint it as text.
//
// ── Two rules this file exists to enforce ──
//
//  1. We never re-derive Hermes' paths. `resolve_whatsapp_bridge_dir()` may
//     mirror the bridge into HERMES_HOME when the install tree is read-only,
//     and `get_hermes_dir()` picks a legacy or a modern session directory
//     depending on what already exists on disk. Guessing either one would pair
//     into a directory the gateway's adapter never reads. So we ask Hermes.
//
//  2. Two Baileys sockets must never share one session directory. Whenever
//     WhatsApp is enabled the gateway's adapter keeps a bridge running, and a
//     second, unpaired socket writing the same folder corrupts it. Pairing
//     therefore stops the gateway first and restores it afterwards.
//
// Hermes source is untouched: we spawn its own script the way it spawns it, and
// we read the paths from its own functions.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findBundledBinDir, isWindows } = require('./platform-utils');

// qrcode-terminal `small` mode: full block, upper half, lower half, and space.
const QR_CHARSET = /^[█▀▄ ]{10,}$/;
const QR_HAS_INK = /[█▀▄]/;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** WhatsApp phone numbers and LIDs are bare digit strings — no `+`, no separators. */
const DIGITS_ONLY = /^\d{7,20}$/;

// Dropped into the session directory by bridge.js when WhatsApp reports the
// linked device was removed. See its `DisconnectReason.loggedOut` branch.
const LOGGED_OUT_MARKER = 'logged-out.json';

// A WhatsApp QR expires and the bridge reissues it, so this is a ceiling on the
// whole ceremony rather than on one code.
const PAIR_TIMEOUT_MS = 4 * 60 * 1000;
const GATEWAY_STOP_TIMEOUT_MS = 30 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ask Hermes where its own bridge and session live, rather than reimplementing
// resolve_whatsapp_bridge_dir() / get_hermes_dir() and drifting from them.
const PROBE = [
    'import json',
    'from gateway.platforms.whatsapp_common import resolve_whatsapp_bridge_dir',
    'from hermes_constants import get_hermes_dir',
    'print(json.dumps({',
    '    "bridgeDir": str(resolve_whatsapp_bridge_dir()),',
    '    "sessionDir": str(get_hermes_dir("platforms/whatsapp/session", "whatsapp/session")),',
    '}))',
].join('\n');

/** The interpreter that sits next to the `hermes` launcher, in the same venv. */
function venvPython(exePath) {
    return path.join(path.dirname(exePath), isWindows ? 'python.exe' : 'python');
}

function probePaths(exePath) {
    return new Promise((resolve, reject) => {
        const py = venvPython(exePath);
        if (!fs.existsSync(py)) {
            return reject(new Error(`No Python interpreter next to the Hermes launcher (${py}).`));
        }
        execFile(py, ['-c', PROBE], { windowsHide: true, timeout: 60000, env: { ...process.env } }, (err, stdout) => {
            if (err) return reject(new Error(`Hermes could not report its WhatsApp paths: ${err.message}`));
            // Warnings may precede the payload; the JSON is the final line.
            const last = String(stdout || '').trim().split(/\r?\n/).pop();
            try {
                const parsed = JSON.parse(last);
                if (!parsed.bridgeDir || !parsed.sessionDir) throw new Error('incomplete');
                resolve(parsed);
            } catch {
                reject(new Error(`Unexpected output while resolving WhatsApp paths: ${last?.slice(0, 200)}`));
            }
        });
    });
}

/** The Node we ship in bin/ (main.js already puts it on PATH for Hermes). */
function resolveNode() {
    const binDir = findBundledBinDir();
    if (binDir) {
        const bundled = path.join(binDir, isWindows ? 'node.exe' : 'node');
        if (fs.existsSync(bundled)) return bundled;
    }
    return null;
}

/**
 * Delete a WhatsApp session. Guarded: only ever removes a directory Hermes
 * itself named `session`, so a bad probe result cannot take out a real tree.
 */
function removeSession(sessionDir) {
    if (path.basename(sessionDir).toLowerCase() !== 'session') {
        throw new Error(`Refusing to delete ${sessionDir}: that is not a WhatsApp session directory.`);
    }
    fs.rmSync(sessionDir, { recursive: true, force: true });
}

/**
 * Empty a session so the next pairing starts clean — the same thing
 * `hermes whatsapp` does when the user answers "yes" to "Re-pair?".
 */
function clearSession(sessionDir) {
    removeSession(sessionDir);
    fs.mkdirSync(sessionDir, { recursive: true });
}

/**
 * The linked account's own identity, read from the session Baileys just wrote.
 *
 * This is what spares the user a form. Hermes' `hermes whatsapp` wizard asks
 * for the phone number because a terminal has nothing else to go on, but
 * `creds.json` already holds it: `me.id` is the full device JID
 * (`<phone>:<device>@s.whatsapp.net`) and `me.lid` its LID twin
 * (`<lid>:<device>@lid`).
 *
 * Both are kept. WhatsApp hands inbound messages to the bridge under either
 * form depending on the chat, and Hermes only resolves one to the other when
 * the bridge's `lid-mapping-*.json` files happen to cover that contact — so
 * allowlisting a single form is a coin flip.
 *
 * Returns null when there is no session yet, or one an older bridge wrote
 * without `me`; callers fall back to asking.
 */
function readSelfIdentity(sessionDir) {
    let me;
    try {
        me = JSON.parse(fs.readFileSync(path.join(sessionDir, 'creds.json'), 'utf8')).me;
    } catch {
        return null;   // not paired yet, or creds.json is mid-write
    }
    if (!me) return null;
    // "923001234567:8@s.whatsapp.net" → "923001234567"
    const bare = (jid) => String(jid || '').split('@')[0].split(':')[0].trim();
    const phone = bare(me.id);
    const lid = bare(me.lid);
    if (!DIGITS_ONLY.test(phone)) return null;
    return { phone, lid: DIGITS_ONLY.test(lid) ? lid : '' };
}

/**
 * Normalize a hand-typed number to the form WhatsApp uses internally.
 *
 * Accepts what people actually type — `+92 300 1234567`, `0092-300-1234567` —
 * and returns `923001234567`. A leading `00` is the international access code
 * and is dropped; any other leading zero is a national trunk prefix we cannot
 * expand without knowing the country, so those are rejected rather than
 * silently turned into the wrong number.
 */
function normalizePhone(raw) {
    let digits = String(raw || '').replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.startsWith('0')) return '';
    return DIGITS_ONLY.test(digits) ? digits : '';
}

class WhatsAppPairing {
    constructor(manager) {
        this.manager = manager;
        this.child = null;
        this.timer = null;
        this.busy = false;
        this.cancelled = false;
    }

    _emit(payload) {
        const win = this.manager.mainWindow;
        try {
            if (win && !win.isDestroyed()) win.webContents.send('hermes-whatsapp-pair', payload);
        } catch { /* window is closing */ }
    }

    /** Everything the modal needs to decide what to show, before starting. */
    async info() {
        const exe = this.manager.resolveExe();
        const { bridgeDir, sessionDir } = await probePaths(exe);
        const bridgeScript = path.join(bridgeDir, 'bridge.js');
        const identity = readSelfIdentity(sessionDir);
        return {
            ok: true,
            bridgeDir,
            sessionDir,
            bridgeScript,
            bridgeReady: fs.existsSync(bridgeScript),
            depsReady: fs.existsSync(path.join(bridgeDir, 'node_modules')),
            nodePath: resolveNode(),
            paired: fs.existsSync(path.join(sessionDir, 'creds.json')),
            // Set when the phone (or WhatsApp) removed this linked device. The
            // session is unrecoverable, so `paired` is already false — this only
            // tells the panel WHY, so it can say "the link was removed, scan
            // again" instead of silently reverting to a never-linked screen.
            loggedOut: fs.existsSync(path.join(sessionDir, LOGGED_OUT_MARKER)),
            running: this.busy,
            // The number the session itself reports, so the panel can confirm
            // WHICH account got linked rather than just that one did.
            phone: identity ? identity.phone : null,
            // False means messages will bounce off the gateway's allowlist —
            // the panel asks for the number by hand in that case.
            allowlisted: await this._envIsSet('WHATSAPP_ALLOWED_USERS').catch(() => false),
        };
    }

    // ── Gateway custody of the session directory ─────────────────────────
    async _gatewayRunning() {
        const res = await this.manager.apiFetch('/api/status');
        return !!(res && res.ok && res.data && res.data.gateway_running);
    }

    async _stopGateway() {
        await this.manager.apiFetch('/api/gateway/stop', { method: 'POST' });
        const deadline = Date.now() + GATEWAY_STOP_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await sleep(1000);
            if (!(await this._gatewayRunning())) return true;
        }
        return false;
    }

    async _startGateway() {
        // Through the manager, not apiFetch: it records the gateway (and the
        // WhatsApp bridge that follows) as ours, so app exit takes them down.
        await this.manager.startGateway();
    }

    /** Start the gateway unless it is already up. */
    async _ensureGatewayRunning() {
        if (await this._gatewayRunning()) return;
        await this._startGateway();
    }

    // ── Switching WhatsApp on ────────────────────────────────────────────
    /** True when Hermes already has a value on disk for `key`. */
    async _envIsSet(key) {
        const res = await this.manager.apiFetch('/api/messaging/platforms');
        if (!res.ok) return false;
        const wa = (res.data?.platforms ?? []).find((p) => p.id === 'whatsapp');
        return !!wa?.env_vars?.find((v) => v.key === key)?.is_set;
    }

    /**
     * True when `key` has a value on disk, for keys the Channels card does not
     * own. `_envIsSet` can only see the three WhatsApp vars Hermes lists on that
     * card; `WHATSAPP_HOME_CHANNEL` is not one of them.
     */
    async _anyEnvIsSet(key) {
        const res = await this.manager.apiFetch('/api/env');
        return !!(res.ok && res.data && res.data[key] && res.data[key].is_set);
    }

    /**
     * Everything Hermes needs on disk before a linked phone actually works.
     *
     * Pairing alone does none of this. Hermes' own `hermes whatsapp` wizard ends
     * by writing these vars (hermes_cli/main.py); KnockDesk drives the same bridge
     * without the wizard, so it has to write them too — otherwise the session is
     * live but every message dies at one gate or another:
     *
     *   WHATSAPP_ENABLED       the single thing the adapter's `_is_connected()`
     *                          keys off. Without it Hermes reports "Platform
     *                          setup is incomplete". The dashboard's enable
     *                          toggle does NOT fix this — that writes `enabled`
     *                          into config.yaml, which is a different flag.
     *
     *   WHATSAPP_MODE          self-chat, so the bridge accepts your messages to
     *                          yourself and ignores everyone else.
     *
     *   WHATSAPP_ALLOWED_USERS the gateway default-DENIES every sender when no
     *                          allowlist exists (gateway/authz_mixin.py:
     *                          `_is_user_authorized`). The adapter's own
     *                          dm_policy is "open", but the gateway deliberately
     *                          refuses to read "open" as authorization — that
     *                          would fail open on a network-exposed adapter. So
     *                          an unlisted number gets a pairing code back
     *                          ("I don't recognize you yet!") instead of an
     *                          answer, and the code can only be approved from a
     *                          terminal KnockDesk doesn't expose.
     *
     *   WHATSAPP_HOME_CHANNEL  where cron and scheduled jobs deliver. Optional:
     *                          chat works without it, only reminders are lost.
     *
     * Values are seeded ONLY when unset, so a user who configured WhatsApp
     * through Hermes directly (a bot number, a wider allowlist, a different home
     * chat) keeps their setup. The one exception is `fresh`: a scan that just
     * completed makes the account it linked authoritative, and any allowlist
     * still on disk describes the account it replaced — seeding around that
     * would leave the phone the user just scanned locked out. Written through
     * Hermes' own REST API — the same endpoint unlink() uses — so KnockDesk never
     * edits Hermes' .env itself.
     *
     * @param {{phone: string, lid: string}|null} identity from `readSelfIdentity`
     * @param {{fresh?: boolean}} options `fresh` when a QR scan just succeeded
     * @returns {Promise<boolean>} whether anything was actually written
     */
    async _enablePlatform(identity, { fresh = false } = {}) {
        const env = { WHATSAPP_ENABLED: 'true' };
        // Hermes' wizard asks for the mode. Seed a default only when the user has
        // never chosen one, so an existing "bot" setup is not downgraded.
        if (!await this._envIsSet('WHATSAPP_MODE')) env.WHATSAPP_MODE = 'self-chat';
        if (identity && (fresh || !await this._envIsSet('WHATSAPP_ALLOWED_USERS'))) {
            env.WHATSAPP_ALLOWED_USERS = [identity.phone, identity.lid].filter(Boolean).join(',');
        }

        const res = await this.manager.apiFetch('/api/messaging/platforms/whatsapp', {
            method: 'PUT',
            body: { enabled: true, env },
        });
        if (!res.ok) {
            throw new Error(`Paired, but Hermes refused to enable WhatsApp (HTTP ${res.status}).`);
        }

        const home = identity ? await this._ensureHomeChannel(identity, { fresh }) : false;
        // WHATSAPP_ENABLED is always in `env`, but re-writing the value it
        // already had changes nothing the gateway would need to re-read.
        return home || Object.keys(env).length > 1;
    }

    /**
     * Point cron / scheduled jobs at the user's own chat.
     *
     * Not part of the platform PUT above: that endpoint whitelists the three
     * vars its Channels card owns and 400s on anything else, so this goes
     * through the generic env endpoint. Same .env file either way.
     *
     * Seeded only when unset, except after a fresh scan — the stored value is a
     * JID built from whichever number was linked last, so re-pairing to a
     * different account has to move it or every reminder keeps going to the old
     * chat.
     *
     * Non-fatal. A missing home channel costs scheduled deliveries, not the
     * conversation, and failing the whole pairing over it would be worse.
     */
    async _ensureHomeChannel(identity, { fresh = false } = {}) {
        try {
            if (!fresh && await this._anyEnvIsSet('WHATSAPP_HOME_CHANNEL')) return false;
            // Hermes hands this straight to the bridge as a chat id, so it needs
            // the full JID rather than the bare number.
            const res = await this.manager.apiFetch('/api/env', {
                method: 'PUT',
                body: { key: 'WHATSAPP_HOME_CHANNEL', value: `${identity.phone}@s.whatsapp.net` },
            });
            return res.ok;
        } catch {
            return false;
        }
    }

    _kill(child) {
        try {
            // The bridge spawns nothing, but a tree kill is what the rest of
            // this codebase uses and it is correct either way.
            if (isWindows) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
            else child.kill('SIGTERM');
        } catch { /* already gone */ }
    }

    /** Run bridge.js --pair-only, streaming its QR and logs to the renderer. */
    _runBridge(info) {
        return new Promise((resolve) => {
            let child;
            try {
                child = spawn(info.nodePath, [info.bridgeScript, '--pair-only', '--session', info.sessionDir], {
                    cwd: info.bridgeDir,
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: { ...process.env },
                });
            } catch (err) {
                return resolve({ ok: false, error: `Could not start the WhatsApp bridge: ${err.message}` });
            }
            this.child = child;

            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                clearTimeout(this.timer);
                this.timer = null;
                this.child = null;
                resolve(result);
            };

            // The bridge prints a whole QR with one console.log, then a
            // "Waiting for scan" line. Collect the block, flush on the first
            // line that isn't part of it. A reissued code replaces the old one.
            let qrLines = [];
            const flushQr = () => {
                if (qrLines.length >= 5) this._emit({ phase: 'qr', qr: qrLines.join('\n') });
                qrLines = [];
            };

            const handleLine = (raw) => {
                const line = raw.replace(ANSI, '').replace(/\r$/, '');
                if (QR_CHARSET.test(line) && QR_HAS_INK.test(line)) {
                    qrLines.push(line);
                    return;
                }
                flushQr();
                const text = line.trim();
                if (text) this._emit({ phase: 'log', line: text });
            };

            let buffer = '';
            const onData = (chunk) => {
                buffer += chunk;
                const parts = buffer.split('\n');
                buffer = parts.pop();
                for (const part of parts) handleLine(part);
            };

            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', onData);
            child.stderr.on('data', onData);

            this.timer = setTimeout(() => {
                this._kill(child);
                finish({ ok: false, error: 'Timed out waiting for the QR code to be scanned.' });
            }, PAIR_TIMEOUT_MS);

            child.on('error', (err) => finish({ ok: false, error: `Could not start the WhatsApp bridge: ${err.message}` }));

            child.on('exit', (code) => {
                if (buffer) handleLine(buffer);
                flushQr();
                // The bridge writes creds.json only once WhatsApp accepts the
                // scan, so the file — not the exit code — is the source of truth.
                if (fs.existsSync(path.join(info.sessionDir, 'creds.json'))) return finish({ ok: true });
                if (this.cancelled) return finish({ ok: false, error: 'Pairing cancelled.' });
                finish({ ok: false, error: `The WhatsApp bridge exited (code ${code}) before pairing completed.` });
            });
        });
    }

    /**
     * @param {{force?: boolean}} options `force` clears an existing session
     *        first — the "Re-pair?" branch of Hermes' own `hermes whatsapp`.
     */
    async start({ force = false } = {}) {
        if (this.busy) return { ok: false, error: 'A pairing is already in progress.' };
        this.busy = true;
        this.cancelled = false;

        let wasRunning = false;
        let wroteEnv = false;
        let outcome;
        try {
            this._emit({ phase: 'starting' });
            const info = await this.info();

            if (!info.bridgeReady) {
                throw new Error(`Hermes' WhatsApp bridge is missing at ${info.bridgeScript}.`);
            }
            if (!info.depsReady) {
                throw new Error(`The WhatsApp bridge has no node_modules in ${info.bridgeDir}.`);
            }
            if (!info.nodePath) {
                throw new Error('The bundled Node runtime is missing — run `npm run download:node`.');
            }

            if (info.paired && !force) {
                outcome = { ok: true, alreadyPaired: true };
            } else {
                // Take the session away from the gateway before touching it.
                wasRunning = await this._gatewayRunning();
                if (wasRunning) {
                    this._emit({ phase: 'gateway-stopping' });
                    if (!await this._stopGateway()) {
                        throw new Error('The Hermes gateway would not stop; it still holds the WhatsApp session.');
                    }
                }

                // A logged-out session keeps everything except creds.json — app
                // state, sender keys, LID mappings — and all of it belongs to a
                // device WhatsApp has already revoked. Pairing on top of that
                // mixes two identities, so start clean. (`force` is the user
                // asking for the same thing via Re-link.)
                if (force || info.loggedOut) clearSession(info.sessionDir);
                fs.mkdirSync(info.sessionDir, { recursive: true });
                outcome = await this._runBridge(info);
            }

            // Idempotent, and it also repairs a session that was paired before
            // these steps existed (creds.json on disk, WHATSAPP_ENABLED never
            // set, or enabled but with nobody on the allowlist).
            //
            // The identity is re-read here rather than taken from `info` above:
            // in the pairing branch that snapshot predates the scan, so it has
            // no creds.json to read yet.
            if (outcome.ok) {
                this._emit({ phase: 'enabling' });
                const identity = readSelfIdentity(info.sessionDir);
                wroteEnv = await this._enablePlatform(identity, { fresh: !outcome.alreadyPaired });
                // Nothing to allowlist means the gateway will bounce the user's
                // own messages; the panel asks for the number instead.
                if (!identity) outcome.needsPhone = true;
            }
        } catch (err) {
            outcome = { ok: false, error: err.message };
        }

        // Hand the session back before announcing the result: 'done' is the
        // renderer's terminal state, and a later 'gateway-starting' would
        // overwrite the outcome on screen with a spinner that never resolves.
        //
        // On success the gateway is started even if it was down to begin with:
        // a linked WhatsApp only receives and answers messages while the gateway
        // runs, so leaving it stopped would hand the user a link that does nothing.
        if (wasRunning || outcome?.ok) {
            this._emit({ phase: 'gateway-starting' });
            try { await this._restartIfStale(wroteEnv); } catch { /* surfaced by the status strip */ }
        }

        this.busy = false;
        this.cancelled = false;
        this._emit({ phase: 'done', ...outcome });
        return outcome;
    }

    /**
     * Bring the gateway up, bouncing it first if it is running with env we just
     * changed underneath it.
     *
     * The gateway reads WHATSAPP_ALLOWED_USERS once, when its adapter is built,
     * so a value written into a live process is invisible until it restarts.
     * The pairing branch gets this for free (the session had to be taken away
     * first, which stopped it), but the already-paired repair branch never
     * stopped anything — and that is exactly the branch that fixes an existing
     * install's missing allowlist. Without the bounce the user would have to
     * restart KnockDesk before their own messages stopped bouncing.
     */
    async _restartIfStale(wroteEnv) {
        if (wroteEnv && await this._gatewayRunning()) await this._stopGateway();
        await this._ensureGatewayRunning();
    }

    /**
     * Disconnect WhatsApp: disable the platform and destroy the local session.
     *
     * Deliberately NOT a full logout. bridge.js exposes no `sock.logout()`, so
     * nothing here can tell WhatsApp's servers to drop the link — the device
     * stays listed under Linked Devices until the user removes it on the phone.
     * The renderer says so; pretending otherwise would leave a live session the
     * user believes is gone.
     *
     * WHATSAPP_ENABLED is flipped through Hermes' own REST API rather than by
     * editing its .env, which KnockDesk never writes.
     */
    async unlink() {
        if (this.busy) return { ok: false, error: 'A pairing is already in progress.' };
        this.busy = true;

        let wasRunning = false;
        let outcome;
        try {
            this._emit({ phase: 'unlinking' });
            const info = await this.info();

            // The gateway's adapter holds the session directory open.
            wasRunning = await this._gatewayRunning();
            if (wasRunning) {
                this._emit({ phase: 'gateway-stopping' });
                if (!await this._stopGateway()) {
                    throw new Error('The Hermes gateway would not stop; it still holds the WhatsApp session.');
                }
            }

            // `enabled: false` alone is not enough — it only clears the flag in
            // Hermes' config.yaml, while the adapter decides from the
            // WHATSAPP_ENABLED env var. Leaving that behind is what produces the
            // "WhatsApp enabled but not paired" state once the session is gone.
            //
            // The allowlist goes too: it names the account being unlinked, and a
            // stale entry would outlive the session it belonged to.
            const res = await this.manager.apiFetch('/api/messaging/platforms/whatsapp', {
                method: 'PUT',
                body: { enabled: false, clear_env: ['WHATSAPP_ENABLED', 'WHATSAPP_ALLOWED_USERS'] },
            });
            if (!res.ok) {
                throw new Error(`Hermes refused to disable WhatsApp (HTTP ${res.status}).`);
            }
            // Same reasoning for the cron target, which is a JID built from that
            // number. Blanked rather than deleted — the generic env endpoint
            // only writes — and Hermes treats an empty home channel as unset.
            try {
                await this.manager.apiFetch('/api/env', {
                    method: 'PUT',
                    body: { key: 'WHATSAPP_HOME_CHANNEL', value: '' },
                });
            } catch { /* cron delivery only; never worth failing an unlink */ }

            removeSession(info.sessionDir);
            outcome = { ok: true, unlinked: true, wasPaired: !!info.paired };
        } catch (err) {
            outcome = { ok: false, error: err.message };
        }

        // WhatsApp is disabled now, so a restarted gateway simply skips it —
        // but the gateway may serve other platforms, so put it back as it was.
        if (wasRunning) {
            this._emit({ phase: 'gateway-starting' });
            try { await this._startGateway(); } catch { /* surfaced by the status strip */ }
        }

        this.busy = false;
        this._emit({ phase: 'done', ...outcome });
        return outcome;
    }

    /**
     * Set the allowlisted number by hand.
     *
     * The backup for the case `readSelfIdentity` cannot cover — a session an
     * older bridge wrote without `me`, or a creds.json we failed to parse. Also
     * the escape hatch when auto-detect picked up the wrong account.
     *
     * Unlike the seeding in `_enablePlatform`, this OVERWRITES: the user is
     * explicitly correcting the value, so deferring to what is already on disk
     * would make the field do nothing. Only the phone number is written — a LID
     * is an internal id nobody can be expected to know, and Hermes resolves it
     * from the bridge's mapping files when it needs to.
     */
    async setPhone(raw) {
        if (this.busy) return { ok: false, error: 'A pairing is already in progress.' };
        const phone = normalizePhone(raw);
        if (!phone) {
            return {
                ok: false,
                error: 'Enter your WhatsApp number with its country code, e.g. 923001234567.',
            };
        }

        this.busy = true;
        let outcome;
        try {
            const res = await this.manager.apiFetch('/api/messaging/platforms/whatsapp', {
                method: 'PUT',
                body: { env: { WHATSAPP_ALLOWED_USERS: phone } },
            });
            if (!res.ok) {
                throw new Error(`Hermes refused to save the number (HTTP ${res.status}).`);
            }
            await this._ensureHomeChannel({ phone, lid: '' });
            outcome = { ok: true, phone };
        } catch (err) {
            outcome = { ok: false, error: err.message };
        }
        this.busy = false;

        // The gateway is holding the old allowlist in memory — see _restartIfStale.
        if (outcome.ok) {
            try { await this._restartIfStale(true); } catch { /* surfaced by the status strip */ }
        }
        return outcome;
    }

    cancel() {
        if (!this.child) return { ok: false, error: 'No pairing is in progress.' };
        this.cancelled = true;
        this._kill(this.child);
        return { ok: true };
    }
}

module.exports = { WhatsAppPairing };
