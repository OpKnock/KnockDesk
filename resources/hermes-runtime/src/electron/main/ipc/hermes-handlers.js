const { ipcMain } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { WhatsAppPairing } = require('../../services/whatsapp-pairing');

// IPC surface for the embedded (but unmodified) Hermes Agent dashboard.
// The renderer never talks to Hermes directly for REST — everything goes
// through HermesManager so the session token stays in the main process.
function registerHermesHandlers({ getHermesManager }) {
  // One pairing controller for the app's lifetime: it holds the running
  // bridge process, so a second instance could orphan the first.
  let pairing = null;
  const getPairing = () => {
    const mgr = getHermesManager();
    if (!mgr) return null;
    if (!pairing) pairing = new WhatsAppPairing(mgr);
    return pairing;
  };
  ipcMain.handle('hermes:get-state', () => {
    const mgr = getHermesManager();
    return mgr ? mgr.getState() : { state: 'idle', url: null, status: null };
  });

  ipcMain.handle('hermes:start', async () => {
    const mgr = getHermesManager();
    if (!mgr) return { state: 'error', error: 'Hermes manager not initialised' };
    return mgr.start();
  });

  // Writing an env var (an API key, from any Settings panel) changes something
  // a RUNNING gateway can never observe — see
  // HermesManager.restartGatewayForCredentialChange() for why. Detecting it here
  // rather than in each Settings panel means a panel added later cannot forget
  // it, and it deliberately does NOT sit inside apiFetch: the WhatsApp pairing
  // flow writes env through the manager directly and already does its own,
  // better-sequenced bounce.
  //
  // ── FAISLA "REQUEST AAYI" PAR NAHI, "VALUE BADLI" PAR ──────────────────────
  //
  // Pehle yahan sirf itna dekha jata tha ke raasta `/api/env` se shuru hota hai
  // aur method likhne wala hai. Us mein do sanginn ghaltiyan thin:
  //
  //   1. `/api/env/reveal` bhi POST hai — magar wo sirf PARHNE ka raasta hai.
  //      Settings ka koi bhi panel ek key dikhane ke liye usay bulata tha, aur
  //      gateway be-wajah restart ho jata tha.
  //
  //   2. Wahi value dobara likhne par bhi restart hota tha. Hermes ke liye kuch
  //      nahi badla hota, magar gateway phir bhi mar kar dobara uthta.
  //
  //   Dono mil kar ek khamosh loop bana sakte hain — aur banaya bhi: `useHermes`
  //   har status-dharkan par Cloud key dobara likh raha tha, jis se gateway har
  //   ~30 second mein restart ho raha tha aur phone se aayi koi command kabhi
  //   poori nahi hoti thi.
  //
  // Ab ye jagah do sawaal poochti hai — "kya ye waqai likhayi hai?" aur "kya
  // value waqai badli hai?" — aur dono ka jawab haan hone par hi gateway ko
  // chhoti hai. Ye poori app ka wahid darwaza hai jahan se renderer Hermes ki
  // env likhta hai, is liye pehra yahin theek baithta hai: kal koi naya panel
  // bane, usay kuch yaad rakhne ki zaroorat nahi.

  const ENV_WRITE_METHODS = ['PUT', 'POST', 'PATCH', 'DELETE'];

  /**
   * `/api/env` par asal likhayi? Haan to `{ key, value }`, warna `null`.
   *
   * `value: null` ka matlab DELETE hai (key hatai ja rahi hai). Sirf `/api/env`
   * khud — uske neeche ke raaste (`/api/env/reveal`) jaan bujh kar bahar hain.
   */
  const envWriteTarget = (apiPath, options) => {
    const path = String(apiPath || '').split('?')[0].replace(/\/+$/, '');
    if (path !== '/api/env') return null;

    const method = String((options && options.method) || 'GET').toUpperCase();
    if (!ENV_WRITE_METHODS.includes(method)) return null;

    const body = (options && options.body) || {};
    const key = String(body.key || '').trim();
    if (!key) return null;

    return { key, value: method === 'DELETE' ? null : String(body.value == null ? '' : body.value) };
  };

  ipcMain.handle('hermes:api', async (_event, apiPath, options) => {
    const mgr = getHermesManager();
    if (!mgr) return { ok: false, status: 0, data: { error: 'Hermes manager not initialised' } };

    const envWrite = envWriteTarget(apiPath, options);

    // Bilkul wahi value jo pichli dafa likhi thi? To Hermes tak request bhejna
    // bhi bekar hai. Jawab wahi banate hain jo ek kaamyab likhayi ka hota —
    // bulane wale ke liye kuch nahi badla, bas disk aur gateway bach gaye.
    if (envWrite && !mgr.envValueChanged(envWrite.key, envWrite.value)) {
      return { ok: true, status: 200, data: { ok: true, key: envWrite.key, unchanged: true } };
    }

    const res = await mgr.apiFetch(apiPath, options || {});

    if (envWrite) {
      // DELETE par 404 ka matlab hai key pehle hi mojood nahi thi — yani halat
      // wohi hai jo bulane wale ne maangi. Usay bhi "ab hamein pata hai" mein
      // ginte hain, warna har dafa dobara wohi be-faida DELETE jata rahega.
      if (res.ok || (envWrite.value === null && res.status === 404)) {
        mgr.rememberEnvValue(envWrite.key, envWrite.value);
      }

      if (res.ok) {
        // Awaited so the renderer's "saved" message only lands once the gateway is
        // actually being restarted; never allowed to fail the save itself.
        try {
          await mgr.restartGatewayForCredentialChange();
        } catch (err) {
          console.warn('[Hermes] Credential-change gateway bounce failed:', err.message);
        }
      }
    }

    return res;
  });

  // Connection info for the renderer's chat WebSocket (Expert Agent chat).
  // Hermes' chat gateway streams over ws://…/api/ws?token=… — the renderer
  // opens that socket itself and re-requests this on every (re)connect so a
  // rotated session token is always current.
  ipcMain.handle('hermes:get-connection', async () => {
    const mgr = getHermesManager();
    if (!mgr) return { ok: false, baseUrl: null, wsUrl: null, token: null, state: 'idle' };
    return mgr.getConnectionInfo();
  });

  // Read-only: Hermes' curated memory files (MEMORY.md + USER.md) for
  // injection into the voice assistant's system prompt. Never writes.
  ipcMain.handle('hermes:memory-read', () => {
    const mgr = getHermesManager();
    if (!mgr) return { available: false, memory: '', user: '' };
    return mgr.readMemoryFiles();
  });

  // Write path: queue a fact for Hermes to evaluate and (maybe) store via
  // its OWN memory tool — KnockDesk never writes Hermes' files itself.
  ipcMain.handle('hermes:share-fact', (_event, payload) => {
    const mgr = getHermesManager();
    if (!mgr) return { ok: false, error: 'Hermes manager not initialised' };
    const { fact, person } = payload || {};
    return mgr.shareFact(fact, person);
  });

  // Interactive memory edit from the Memory modal: a plain-language request
  // ("add X", "fix Y", "forget Z") handed to Hermes' agent. Awaited so the
  // modal can show the result and re-read the (Hermes-written) files.
  ipcMain.handle('hermes:memory-request', async (_event, payload) => {
    const mgr = getHermesManager();
    if (!mgr) return { ok: false, error: 'Hermes manager not initialised' };
    const { instruction } = payload || {};
    return mgr.memoryRequest(instruction);
  });

  // ── WhatsApp pairing (see services/whatsapp-pairing.js) ────────────────
  // Hermes' `hermes whatsapp` command is interactive and prints its QR to a
  // terminal the packaged app does not have. We run the same bridge script it
  // runs and stream the QR to a KnockDesk modal over `hermes-whatsapp-pair`.

  ipcMain.handle('hermes:whatsapp-pair-info', async () => {
    const wa = getPairing();
    if (!wa) return { ok: false, error: 'Hermes manager not initialised' };
    try {
      return await wa.info();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('hermes:whatsapp-pair-start', async (_event, options) => {
    const wa = getPairing();
    if (!wa) return { ok: false, error: 'Hermes manager not initialised' };
    // Resolves only when pairing settles; progress arrives as events.
    return wa.start({ force: !!(options && options.force) });
  });

  ipcMain.handle('hermes:whatsapp-pair-cancel', () => {
    const wa = getPairing();
    if (!wa) return { ok: false, error: 'Hermes manager not initialised' };
    return wa.cancel();
  });

  // Backup for the number pairing normally reads out of the session itself.
  ipcMain.handle('hermes:whatsapp-set-phone', async (_event, options) => {
    const wa = getPairing();
    if (!wa) return { ok: false, error: 'Hermes manager not initialised' };
    return wa.setPhone(options && options.phone);
  });

  // Disables WhatsApp and destroys the local session. The linked device must
  // still be removed on the phone — the bridge has no logout call.
  ipcMain.handle('hermes:whatsapp-unlink', async () => {
    const wa = getPairing();
    if (!wa) return { ok: false, error: 'Hermes manager not initialised' };
    return wa.unlink();
  });

  // Guest preload for the dashboard <webview>: lets the injected "Set up with
  // QR" button on Hermes' Channels page call back into KnockDesk.
  ipcMain.handle('hermes:get-preload-path', () => {
    try {
      return pathToFileURL(path.join(__dirname, '..', '..', 'hermes-preload.js')).toString();
    } catch {
      return null;
    }
  });
}

module.exports = { registerHermesHandlers };
