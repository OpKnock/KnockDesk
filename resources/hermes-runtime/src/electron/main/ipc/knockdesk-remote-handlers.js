// Mobile Remote ka IPC — main process aur renderer ke darmiyan.
//
// ════════════════════════════════════════════════════════════════════════════
//  KAAM DO HISSON MEIN BATA HUA KYUN HAI
// ════════════════════════════════════════════════════════════════════════════
//
//  main process     : Hermes ke plugin ka local darwaza (TCP socket sirf yahan
//                     khul sakta hai) aur Hermes ki config/env ka intezam
//
//  renderer         : Supabase Realtime ka poora connection (browser ka
//                     WebSocket, token refresh, presence)
//
//  Ye file un dono ko jorti hai. Beech mein aur kuch nahi:
//
//      🐍 plugin ──▶ bridge ──[ ye file ]──▶ renderer ──▶ Supabase ──▶ 📱
//                        ◀────────────────────────────────────────────
//
// ════════════════════════════════════════════════════════════════════════════
//  EK BAAT JO ASAANI SE CHOOT JATI HAI
// ════════════════════════════════════════════════════════════════════════════
//
//  Renderer reload ho sakta hai (dev mein har save par, production mein kabhi
//  kabhi). Bridge aur Hermes ka plugin us se bilkul mutasir nahi hote — wo
//  main process aur Python mein hain. Is liye renderer ke dobara aate hi usay
//  MOJOODA halat batani parti hai, warna wo "plugin juda hi nahi" samajh kar
//  phone par jhoota offline dikhata rahega.
//
//  Yehi kaam `knockdesk-remote:status` karta hai, aur renderer usay har dafa
//  shuru mein poochta hai — event ka intezaar kiye baghair.

const { ipcMain, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * Phone par bhejne ke liye file ki hadd.
 *
 * Ye "storage bacha lo" wali hadd nahi hai. Wajah amli hai: file yahan se
 * base64 mein renderer tak jati hai, phir upload hoti hai, phir phone use
 * mobile data par utaarta hai. 25MB se aage ye poora silsila mahenga aur sust
 * ho jata hai, aur phone par aisi file ka koi faida bhi nahi. Us se bari cheez
 * ke liye sahi jawab "chhoti bana kar bhejo ya link bhejo" hai — chup-chaap
 * atak jane se kahin behtar.
 */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Aam extension ka mime — phone isi se tay karta hai ke tasveer dikhani hai ya nahi. */
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/**
 * @param {object} deps
 * @param {() => import('../../services/knockdesk-bridge').KnockDeskBridge|null} deps.getBridge
 * @param {() => any} deps.getHermesManager
 */
function registerKnockDeskRemoteHandlers({ getBridge, getHermesManager }) {
  // ── Halat poochna ────────────────────────────────────────────────────────
  ipcMain.handle('knockdesk-remote:status', () => {
    const bridge = getBridge();
    if (!bridge) return { ok: false, pluginConnected: false, error: 'bridge_not_started' };
    return { ok: true, pluginConnected: bridge.pluginConnected, port: bridge.port };
  });

  // ── Hermes ko KnockDesk platform ke liye tayyar karna ───────────────────────
  //
  // Renderer ye tab chalata hai jab usay user ki pehchan (chatId) maloom ho
  // jati hai — yani Supabase ka channel judne ke baad. Pehle nahi: Hermes ki
  // .env mein khali `STONIC_CHAT_ID` likhne ka matlab hota ke authorization
  // list khali reh jati aur koi bhi paighaam rad ho jata.
  //
  // ── YE AB INTEZAAR NAHI KARWATA ──────────────────────────────────────────
  //
  // Pehle yahan `ensureKnockDeskPlatform()` seedha `await` hota tha, aur us ka
  // jawab renderer ke liye AAKHRI faisla hota tha: Hermes us lamhe tayyar na
  // ho to "nahi ho saka" — aur phir kabhi koshish na hoti. Packaged app mein
  // wo hamesha yehi jawab deta tha, kyunki Supabase ka channel 1-3 second mein
  // jur jata hai jabke bundled Hermes ko minute lag sakte hain.
  //
  // Ab ye sirf DARKHWAST daalta hai. Asal kaam HermesManager karta hai — jab
  // wo tayyar ho, aur nakaam ho to dobara. `pending: true` ka matlab "qatar
  // mein hai", nakaami nahi.
  ipcMain.handle('knockdesk-remote:ensure', (_event, { chatId } = {}) => {
    const bridge = getBridge();
    const hermes = getHermesManager();

    if (!bridge || !bridge.port) return { ok: false, error: 'Bridge abhi chala nahi.' };
    if (!hermes) return { ok: false, error: 'Hermes manager abhi tayyar nahi.' };

    try {
      return hermes.requestKnockDeskPlatform({
        bridgeUrl: `http://127.0.0.1:${bridge.port}`,
        bridgeKey: bridge.key,
        chatId: chatId ? String(chatId) : '',
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── Phone se aaya paighaam Hermes tak ────────────────────────────────────
  //
  // `delivered: false` ka matlab hai plugin juda hi nahi — yani Hermes abhi
  // kaam nahi le sakta. Renderer is par phone ko saaf batata hai; command
  // chup-chaap girni nahi chahiye.
  ipcMain.handle('knockdesk-remote:inbound', (_event, message) => {
    const bridge = getBridge();
    if (!bridge) return { delivered: false, error: 'bridge_not_started' };

    const delivered = bridge.deliverInbound({
      id: message?.id,
      chatId: message?.chatId,
      userId: message?.userId,
      userName: message?.userName,
      text: message?.text,
      ts: message?.ts,
    });
    return { delivered };
  });

  // ── Hermes ki mojooda session ka id ──────────────────────────────────────
  //
  // Renderer ko ye is liye chahiye ke wo Supabase wali guftagu ko Hermes ki
  // session ke saath baandh sake — yehi wo dhaaga hai jis se kal purani chat
  // par WAQAI wapas jaya ja sakta hai (screen bhi purani, aur agent ki yaad
  // bhi purani).
  //
  // `source=knockdesk` sab se ahem hissa hai. Is platform ki ek waqt mein sirf
  // EK session chalti hai (har user ka ek hi chat id), is liye "sab se nayi
  // knockdesk session" hamesha wohi hai jis mein abhi baat ho rahi hai. Bina is
  // filter ke desktop par khuli kisi doosri chat ki session utha li jati, aur
  // mobile chat kisi aur silsile se jur jati — ek aisi ghalti jo hafton baad,
  // ek ajeeb jawab ki shakl mein pakri jati.
  ipcMain.handle('knockdesk-remote:hermes-session', async () => {
    const hermes = getHermesManager();
    if (!hermes) return { ok: false, error: 'hermes_not_ready' };

    try {
      const res = await hermes.apiFetch('/api/sessions?source=knockdesk&order=recent&limit=1');
      if (!res?.ok) return { ok: false, error: `http_${res?.status || 0}` };

      const rows = Array.isArray(res.data?.sessions)
        ? res.data.sessions
        : Array.isArray(res.data)
          ? res.data
          : [];

      const sessionId = rows[0]?.id ? String(rows[0].id) : '';
      if (!sessionId) return { ok: false, error: 'no_session' };

      return { ok: true, sessionId };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── Phone ke liye ek file parhna ─────────────────────────────────────────
  //
  // Renderer (browser) disk ko chhoo hi nahi sakta, is liye ye kaam yahan hai.
  //
  // Raaste ki koi "allowed folders" wali fehrist JAAN BUJH KAR nahi hai, aur
  // ye baat sochne wali hai: raasta Hermes deta hai, aur Hermes isi machine
  // par, isi user ke ikhtiyar se chal raha hai — wo ye file waise bhi parh
  // sakta hai. Fehrist lagane se ek bhi nayi hifazat nahi milti, sirf feature
  // ke aadhe istemal band ho jate ("Downloads mein pari report bhejo").
  //
  // Asal pehra kahin aur hai: ye darwaza sirf 127.0.0.1 par khulta hai, ek
  // secret maangta hai, aur us se pehle Supabase par user ka apna token.
  ipcMain.handle('knockdesk-remote:read-file', async (_event, { path: filePath } = {}) => {
    const target = String(filePath || '').trim();
    if (!target) return { ok: false, error: 'no path' };

    try {
      const stat = await fs.stat(target);

      if (!stat.isFile()) return { ok: false, error: 'not a file' };
      if (stat.size === 0) return { ok: false, error: 'file is empty' };
      if (stat.size > MAX_FILE_BYTES) {
        const mb = (stat.size / (1024 * 1024)).toFixed(1);
        return { ok: false, error: `file is ${mb} MB — limit is 25 MB` };
      }

      const buffer = await fs.readFile(target);
      const name = path.basename(target);
      const mime = MIME_BY_EXT[path.extname(target).toLowerCase()] || 'application/octet-stream';

      return {
        ok: true,
        file: {
          name,
          mime,
          size: stat.size,
          // Data URL is liye ke renderer usay ek line mein blob bana leta hai
          // (`fetch(dataUrl)`), aur wo base64 ko haath se kholne se kai guna
          // tez hai — 20MB par ye farq mehsoos hota hai.
          dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
        },
      };
    } catch (err) {
      return { ok: false, error: err.code === 'ENOENT' ? 'file not found' : err.message };
    }
  });
}

/**
 * Bridge ke events ko renderer tak pohnchana.
 *
 * Har khuli window ko bhejte hain, sirf main window ko nahi. Wajah: main
 * window kabhi kabhi band aur dobara ban sakti hai (macOS par dock se), aur
 * ek yaad rakhi hui purani window ka reference us waqt mara hua hota hai.
 * `getAllWindows()` hamesha wo bhejta hai jo is waqt zinda hai.
 */
function wireBridgeToRenderer(bridge) {
  const send = (channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };

  bridge.onPluginState((connected) => {
    send('knockdesk-remote:plugin-state', { connected });
  });

  bridge.onOutbound((payload) => {
    send('knockdesk-remote:outbound', payload);
  });
}

module.exports = {
  registerKnockDeskRemoteHandlers,
  // Purana naam alias (koi bahar wala purana naam le to na toote).
  registerKnockDeskRemoteHandlers: registerKnockDeskRemoteHandlers,
  wireBridgeToRenderer,
};
