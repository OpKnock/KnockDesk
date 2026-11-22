// KnockDesk Bridge — Hermes ke plugin aur phone ke darmiyan ka chhota sa pul.
//
// ════════════════════════════════════════════════════════════════════════════
//  YE KYUN MOJOOD HAI
// ════════════════════════════════════════════════════════════════════════════
//
//  Phone tak paighaam Supabase Realtime se jata hai, aur us ka poora code
//  renderer mein hai (browser ka WebSocket wahan pehle se mojood hai).
//
//  Hermes ka plugin ek alag PYTHON process mein chalta hai. Wo renderer se
//  seedha baat nahi kar sakta — do alag process hain. Usay ek asli TCP
//  darwaza chahiye, aur socket sirf main process khol sakta hai.
//
//  Is liye tarteeb ye hai:
//
//      🐍 Hermes plugin  ──HTTP──▶  [ YE FILE ]  ──IPC──▶  renderer  ──▶  Supabase  ──▶  📱
//
//  Ye bilkul wohi tareeqa hai jo Hermes ka apna WhatsApp adapter istemal
//  karta hai (wo bhi ek local Node bridge se baat karta hai). Is se Hermes ke
//  Python packages mein ek bhi nayi cheez add nahi karni parti.
//
// ════════════════════════════════════════════════════════════════════════════
//  DO RAASTE, DONO CHHOTE
// ════════════════════════════════════════════════════════════════════════════
//
//    GET  /v1/in   -> plugin ye stream khol kar baitha rehta hai. Phone se
//                     aaya har paighaam yahan se us tak jata hai (NDJSON —
//                     ek line, ek paighaam).
//
//    POST /v1/out  -> Hermes ka har jawab, tool ka progress, typing ka
//                     nishan, aur turn ka aaghaz/anjaam — sab yahan se aata
//                     hai aur renderer ke zariye phone tak jata hai.
//
//  Aur is stream ka khula hona hi wo nishani hai jis se hum jaante hain ke
//  Hermes ka platform ZINDA hai. Phone par sabz nuqta isi par jalta hai —
//  "app khuli hai" par nahi, "Hermes waqai kaam le sakta hai" par.
//
// ════════════════════════════════════════════════════════════════════════════
//  MEHFOOZ KYUN HAI
// ════════════════════════════════════════════════════════════════════════════
//
//  1. Sirf 127.0.0.1 par sunta hai — network se koi is tak pohnch hi nahi
//     sakta, chahe wo usi Wi-Fi par ho.
//  2. Har request par ek secret maangta hai jo sirf isi machine par, sirf
//     is user ke apne folder mein likha hai.
//  3. Us se pehle ka asal pehra Supabase par hai: phone ko us account ka
//     signed token dikhana parta hai jis ka channel hai.

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Pehli koshish is port par. Yehi rehne se Hermes ki .env baar baar likhni
// nahi parti aur gateway ko bar bar restart nahi karna parta.
// (9119 = Hermes dashboard, 8642 = Hermes run API — dono se door.)
const PREFERRED_PORT = parseInt(process.env.KNOCKDESK_BRIDGE_PORT || process.env.STONIC_BRIDGE_PORT || '8749', 10);

// Stream par har itni der baad ek ping. Do kaam karta hai: proxy/OS ko socket
// zinda batata hai, aur plugin ko pata chalta rehta hai ke bridge sun raha hai.
const PING_INTERVAL_MS = 60_000; // idle-throttled (was 20s)

// Body ki hadd. Hermes ka jawab lamba ho sakta hai magar be-hadd nahi —
// aur ek local darwaza bhi bina hadd ke nahi chhorna chahiye.
const MAX_BODY_BYTES = 1024 * 1024;

class KnockDeskBridge {
  constructor({ userDataDir }) {
    this._userDataDir = userDataDir;
    this._server = null;
    this._port = null;
    this._key = null;

    /** Hermes plugin ka khula hua stream. Ek waqt mein sirf EK. */
    this._stream = null;
    this._pingTimer = null;

    this._stateListeners = new Set();
    this._outboundListeners = new Set();
  }

  get port() {
    return this._port;
  }

  get key() {
    return this._key;
  }

  /** Hermes ka plugin abhi juda hua hai? Yehi phone ka sabz nuqta banata hai. */
  get pluginConnected() {
    return this._stream !== null;
  }

  /** Plugin jure ya toote — khabar. */
  /** ComputerManager jo `/v1/computer/*` sambhalta hai. */
  setComputerManager(mgr) { this._computer = mgr || null; }

  /**
   * Memory Core ka handler jo `/v1/memory/*` sambhalta hai:
   * `(req, res, url) => Promise<void>` (electron/services/memory/bridge.js).
   */
  setMemoryHandler(handler) { this._memory = typeof handler === 'function' ? handler : null; }

  onPluginState(listener) {
    this._stateListeners.add(listener);
    return () => this._stateListeners.delete(listener);
  }

  /** Hermes ki taraf se phone ke liye kuch aaya. */
  onOutbound(listener) {
    this._outboundListeners.add(listener);
    return () => this._outboundListeners.delete(listener);
  }

  // ── Zindagi ───────────────────────────────────────────────────────────────

  async start() {
    if (this._server) return { port: this._port, key: this._key };

    this._key = this._loadOrCreateKey();

    const server = http.createServer((req, res) => this._route(req, res));

    // Socket ko khud band na karo — `/v1/in` ghanton khula rehta hai aur
    // Node ka default timeout usay chup-chaap kaat deta.
    server.timeout = 0;
    server.headersTimeout = 0;
    server.requestTimeout = 0;
    server.keepAliveTimeout = 0;

    this._port = await this._listen(server);
    this._server = server;

    console.log(`[KnockDeskBridge] 127.0.0.1:${this._port} par sun raha hai.`);
    return { port: this._port, key: this._key };
  }

  /**
   * Port par baithna — pehle apna manpasand, warna jo OS de de.
   *
   * Manpasand port pehle is liye ke wo Hermes ki .env mein likha rehta hai;
   * har baar naya port lene ka matlab har baar .env likhna aur gateway ko
   * restart karna hota — yani har app launch par Hermes ka ek bounce.
   *
   * Magar us par ziddh bhi nahi karte: koi doosri cheez us par baithi ho to
   * app ka ye feature bilkul band ho jata. Ephemeral port us se behtar hai.
   */
  _listen(server) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
          server.removeListener('error', onError);
          server.listen(0, '127.0.0.1', () => resolve(server.address().port));
          server.once('error', reject);
          return;
        }
        reject(err);
      };

      server.once('error', onError);
      server.listen(PREFERRED_PORT, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve(server.address().port);
      });
    });
  }

  stop() {
    this._closeStream('bridge band ho raha hai');

    if (this._server) {
      try {
        this._server.close();
      } catch {
        /* pehle hi band */
      }
      this._server = null;
    }
    this._port = null;
  }

  // ── Key ───────────────────────────────────────────────────────────────────

  /**
   * Secret disk par rakhte hain, har baar naya nahi banate.
   *
   * Wajah wohi hai jo port ki hai: key badalte hi Hermes ki .env ghalat ho
   * jati hai aur gateway ko restart karna parta hai. Ek hi key rehne se app
   * kholna Hermes ko chherta hi nahi.
   */
  _loadOrCreateKey() {
    const file = path.join(this._userDataDir, 'knockdesk-bridge-key');
    const valid = (s) => /^[0-9a-f]{64}$/.test((s || '').trim());
    try {
      const saved = fs.readFileSync(file, 'utf8').trim();
      if (valid(saved)) return saved;
    } catch {
      /* pehli dafa — neeche dekho */
    }
    // One-time rebrand migration: purani key apnao (taake Hermes ki .env
    // aur gateway restart na ho), naye naam se save karo.
    try {
      const legacy = path.join(this._userDataDir, 'knockdesk-bridge-key');
      const old = fs.readFileSync(legacy, 'utf8').trim();
      if (valid(old)) {
        try { fs.writeFileSync(file, old, { mode: 0o600 }); } catch { /* save na ho saki — key waise bhi return hogi */ }
        return old;
      }
    } catch { /* purani key nahi — neeche nayi ban jayegi */ }

    const fresh = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(file, fresh, { mode: 0o600 });
    } catch (err) {
      // Save na ho saki: is session mein sab chalta rahega, agli dafa nayi
      // key banegi aur Hermes ki .env us waqt update ho jayegi.
      console.warn('[KnockDeskBridge] Key save nahi hui:', err.message);
    }
    return fresh;
  }

  /**
   * Key ka muqabla — waqt ke lehaz se barabar (timing-safe).
   *
   * Saada `===` har harf par pehle farq milte hi ruk jata hai, aur us se
   * lagne wale waqt ka farq nap kar key ek ek harf kar ke andaza lagayi ja
   * sakti hai. Ye darwaza sirf localhost par hai, magar sahi tareeqa itna
   * saada hai ke ghalat tareeqa chunne ki koi wajah nahi.
   */
  _keyOk(req) {
    const header = req.headers.authorization || '';
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!given || !this._key || given.length !== this._key.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(this._key));
    } catch {
      return false;
    }
  }

  // ── Raaste ────────────────────────────────────────────────────────────────

  _route(req, res) {
    const url = (req.url || '').split('?')[0];

    if (!this._keyOk(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (req.method === 'GET' && url === '/v1/in') {
      this._openStream(req, res);
      return;
    }

    if (req.method === 'POST' && url === '/v1/out') {
      this._readOutbound(req, res);
      return;
    }

    // Computer use — Hermes ka `computer_task` plugin isi darwaze se Agent S3
    // sidecar tak pohnchta hai (ComputerManager.handleBridgeRequest).
    if (url.startsWith('/v1/computer/') && this._computer) {
      this._computer.handleBridgeRequest(req, res, url);
      return;
    }

    // Memory Core — Hermes ka `knockdesk-memory` provider isi darwaze se wohi
    // yaadash parhta/likhta hai jo voice istemal karti hai. Handler apni har
    // ghalti khud JSON mein lautata hai; ye catch sirf aakhri jaal hai, kyunke
    // is server ke timeouts 0 hain aur be-jawab request hamesha latki rehti.
    if (url.startsWith('/v1/memory/') && this._memory) {
      Promise.resolve()
        .then(() => this._memory(req, res, url))
        .catch(() => {
          try {
            if (!res.writableEnded) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'internal_error' }));
            }
          } catch { /* socket pehle hi band */ }
        });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  }

  /**
   * Plugin ka stream. Ek waqt mein sirf EK.
   *
   * Do kyun nahi: gateway restart hone par purana stream kabhi kabhi abhi
   * marta nahi (TCP ko pata chalne mein waqt lagta hai). Agar hum dono ko
   * rakh lein to phone se aayi ek command DONO ko jayegi — aur Hermes usay
   * do dafa chalayega. Naya hamesha jeetta hai, purana foran band.
   */
  _openStream(req, res) {
    if (this._stream) {
      console.log('[KnockDeskBridge] Naya plugin stream aaya — purana band kar rahe hain.');
      this._closeStream('naya stream aa gaya', { silent: true });
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });

    this._stream = res;

    this._pingTimer = setInterval(() => {
      if (!this._stream || this._stream.writableEnded || this._stream.destroyed) return;
      this._write({ type: 'ping' });
    }, PING_INTERVAL_MS);
    if (this._pingTimer && this._pingTimer.unref) this._pingTimer.unref();

    // ── HAR HANDLER SIRF APNE STREAM KA ZIMMEDAAR HAI ─────────────────────
    //
    // `res` par bandha hua ye check bohat ahem hai. Jab naya stream aata hai
    // to hum purane ko band karte hain, aur us ka `close` event ek lamha BAAD
    // chalta hai — us waqt tak naya stream lag chuka hota hai.
    //
    // Bina is check ke wo purana handler NAYE stream ko band kar deta: gateway
    // ke har restart par plugin jurte hi wapas kat jata, aur phone par nuqta
    // chand second sabz ho kar bujh jata. Wajah dhoondna bohat mushkil hota,
    // kyunki har cheez alag alag theek nazar aati hai.
    const drop = () => {
      if (this._stream !== res) return;
      this._closeStream('plugin chala gaya');
    };
    req.on('close', drop);
    req.on('error', drop);
    res.on('error', drop);

    console.log('[KnockDeskBridge] Hermes ka plugin juda — phone ke liye tayyar.');
    this._emitState(true);
  }

  _closeStream(reason, { silent = false } = {}) {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }

    const stream = this._stream;
    this._stream = null;

    if (stream) {
      try {
        stream.end();
      } catch {
        /* pehle hi ja chuka */
      }
      if (!silent) {
        console.log(`[KnockDeskBridge] Plugin ka stream band: ${reason}`);
        this._emitState(false);
      }
    }
  }

  _readOutbound(req, res) {
    const chunks = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_json' }));
        return;
      }

      // Jawab foran de dete hain, sunne walon ka intezaar kiye baghair.
      // Wajah: Hermes ka turn is POST par ruka hua hai. Agar hum yahan
      // Supabase ka intezaar karein to net ki har sust'i seedha Hermes ki
      // raftaar ban jayegi.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));

      for (const listener of this._outboundListeners) {
        try {
          listener(payload);
        } catch (err) {
          console.warn('[KnockDeskBridge] Outbound listener fail hua:', err.message);
        }
      }
    });

    req.on('error', () => {
      if (!aborted && !res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'read_error' }));
      }
    });
  }

  // ── Phone se Hermes tak ───────────────────────────────────────────────────

  /**
   * Phone se aayi command Hermes tak pohnchana.
   *
   * `false` ka matlab hai plugin juda hua hi nahi — yani Hermes abhi kaam
   * nahi le sakta. Aisi surat mein command chup-chaap girni NAHI chahiye:
   * caller ko phone par saaf batana hota hai.
   */
  deliverInbound({ id, chatId, userId, userName, text, ts }) {
    if (!this._stream) return false;
    return this._write({
      type: 'message',
      id: String(id),
      chat_id: String(chatId),
      user_id: String(userId),
      user_name: userName ? String(userName) : 'KnockDesk',
      text: String(text),
      ts: ts || Date.now(),
    });
  }

  _write(frame) {
    if (!this._stream) return false;
    try {
      return this._stream.write(`${JSON.stringify(frame)}\n`);
    } catch (err) {
      console.warn('[KnockDeskBridge] Stream par likha nahi ja saka:', err.message);
      this._closeStream('likhne mein masla');
      return false;
    }
  }

  _emitState(connected) {
    for (const listener of this._stateListeners) {
      try {
        listener(connected);
      } catch (err) {
        console.warn('[KnockDeskBridge] State listener fail hua:', err.message);
      }
    }
  }
}

module.exports = { KnockDeskBridge };

// Compat: pre-rebrand main.jsc destructures StonicBridge.
module.exports.StonicBridge = module.exports.KnockDeskBridge;
