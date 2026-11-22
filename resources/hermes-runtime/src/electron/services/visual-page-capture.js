// Visual Hub ke page ki POORI tasveer — upar se neeche tak, ek hi PNG.
//
// ════════════════════════════════════════════════════════════════════════════
//  YE FILE KYUN MOJOOD HAI
// ════════════════════════════════════════════════════════════════════════════
//
//  Hub ka "Save" pehle `capturePage` se sirf wohi hissa leta tha jo screen par
//  nazar aa raha ho. Page ab lamba hota hai (scroll hota hai), is liye tasveer
//  adhoori aati thi. Window ke bahar ka hissa `capturePage` le hi nahi sakta.
//
//  Hal: page ko ek chhupi hui (offscreen) window mein dobara lagao, us ki poori
//  lambai naapo, DevTools protocol se us window ki "screen" ko utna hi lamba
//  kar do, aur phir tasveer lo.
//
//  "Viewport se bahar tak" wali tasveer (captureBeyondViewport) yahan kaam
//  nahi karti: page ek sandboxed iframe mein hai, Chromium use alag process
//  mein chalata hai, aur wo process sirf utna hi paint karta hai jitna screen
//  ke andar ho — baqi tasveer kaali aati hai. Is liye screen hi lambi ki jati hai.
//
// ── HIFAZAT ─────────────────────────────────────────────────────────────────
//
//  Page ek model ka likha hua hai (src/lib/visual/frame.ts ka sar-naama dekho),
//  aur yahan wo dobara chalta hai. Is liye yahan bhi wohi teen taale:
//
//    1. Page seedha window mein nahi lagta — window mein hamara apna khali khol
//       hota hai aur page us ke andar `sandbox="allow-scripts"` iframe mein,
//       bilkul jaise hub mein. (Seedha lagta to us ka `window.open` aur
//       navigation main.js ke aam pehre tak pohnchte, jo link ko system browser
//       mein khol deta hai.)
//    2. Page ke document mein us ka apna CSP hai (frame.ts) — yahan bhi wohi.
//    3. Is window ka apna alag session hai jis par har network request rad hai.
//
//  Page se sirf ek number liya jata hai (lambai), aur wo bhi hadd mein kata hua.

const { BrowserWindow, session } = require('electron');

const PARTITION = 'visual-hub-capture';
/** Chromium ki tasveer ki hadd ~16,384 px hai. */
const MAX_DIMENSION = 16000;
/** 2x par itne pixels tak; is se bari tasveer 1x par banti hai. */
const MAX_PIXELS = 48_000_000;
/** Page ki entrance animation aur script ko thehrne ka waqt. */
const SETTLE_MS = 1300;
const RESIZE_SETTLE_MS = 450;
/** Screen lambi karne ke baad naya hissa paint hone ka waqt. */
const GROW_SETTLE_MS = 500;
const TIMEOUT_MS = 25_000;
/** data: URL ki hadd ~2 MB hai; base64 se pehle is se bara document rad. */
const MAX_DOCUMENT_CHARS = 1_200_000;

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sessionGuarded = false;
const captureSession = () => {
  const ses = session.fromPartition(PARTITION);
  if (!sessionGuarded) {
    sessionGuarded = true;
    ses.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !/^(data|blob|about|devtools):/i.test(details.url) });
    });
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  }
  return ses;
};

/**
 * `vh` ko px mein jama dena.
 *
 * Poori tasveer ke liye iframe ko page jitna lamba karna parta hai, aur us ke
 * saath page ka "viewport" bhi utna hi lamba ho jata hai. `min-height: 100vh`
 * wala hero phir poore page jitna phail jata aur baqi page neeche dhakel deta.
 * Yahan `vh` usi oonchai par jam jata hai jo hub mein thi — tasveer wohi
 * layout dikhati hai jo user ne dekha.
 */
const freezeViewportUnits = (html, viewHeight) => {
  const fix = (css) => css.replace(/(\d*\.?\d+)[dsl]?vh\b/gi, (_whole, n) => `${((Number(n) * viewHeight) / 100).toFixed(2)}px`);
  return html
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_whole, open, css, close) => open + fix(css) + close)
    .replace(/(\sstyle\s*=\s*")([^"]*)(")/gi, (_whole, open, css, close) => open + fix(css) + close)
    .replace(/(\sstyle\s*=\s*')([^']*)(')/gi, (_whole, open, css, close) => open + fix(css) + close);
};

const escapeAttribute = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

const shellDocument = (pageDocument, viewHeight) => '<!doctype html><html><head><meta charset="utf-8">'
  + '<style>html,body{margin:0;background:#000}iframe{display:block;width:100%;border:0}</style></head><body>'
  + `<iframe sandbox="allow-scripts" style="height:${viewHeight}px" srcdoc="${escapeAttribute(pageDocument)}"></iframe>`
  + '</body></html>';

const MEASURE = 'Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))';

const capture = async (win, { html, width, height }) => {
  const contents = win.webContents;
  const devtools = contents.debugger;
  const viewWidth = clamp(Math.round(Number(width) || 1280), 480, 2400);
  const viewHeight = clamp(Math.round(Number(height) || 800), 320, 2000);

  const shell = shellDocument(freezeViewportUnits(html, viewHeight), viewHeight);
  if (shell.length > MAX_DOCUMENT_CHARS) throw new Error('page_too_large');

  contents.setAudioMuted(true);
  // Aam pehra (main.js) link ko system browser mein kholta hai — yahan kuch nahi khulta.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  // Page khud ko kahin le jane ki koshish kare (`location = ...`): request to
  // session par rad ho hi jati, magar us ki jagah Chromium ka "blocked" wala
  // error page aa jata aur tasveer usi ki banti. Yahan safar shuru hi nahi hota.
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && !String(event.url || '').startsWith('about:')) event.preventDefault();
  });

  // Pehle ek khali page: Electron 34 par `Emulation.*` command kisi page ke
  // load hone se pehle bhejo to poora process gir jata hai (native crash).
  await contents.loadURL('about:blank');
  devtools.attach('1.3');
  const metrics = (screenHeight, deviceScaleFactor) => devtools.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: viewWidth, height: screenHeight, deviceScaleFactor, mobile: false,
  });
  // Shuru mein screen wohi jo hub mein thi: page usi size par load ho kar apna layout banata hai.
  await metrics(viewHeight, 1);
  await contents.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(shell, 'utf8').toString('base64')}`);

  const pageFrame = contents.mainFrame.frames[0];
  if (!pageFrame) throw new Error('page_frame_missing');
  await delay(SETTLE_MS);

  const measure = async () => clamp(Number(await pageFrame.executeJavaScript(MEASURE)) || viewHeight, viewHeight, MAX_DIMENSION);
  const stretch = (px) => contents.executeJavaScript(`document.querySelector('iframe').style.height = '${px}px'; void 0`);

  let fullHeight = await measure();
  await stretch(fullHeight);
  await delay(RESIZE_SETTLE_MS);
  // Lamba hone par kuch pages thora aur barh jate hain (% wali oonchaiyan) — ek dafa aur, bas.
  const again = await measure();
  if (again > fullHeight + 2) {
    fullHeight = again;
    await stretch(fullHeight);
    await delay(200);
  }

  const sharp = viewWidth * 2 <= MAX_DIMENSION && fullHeight * 2 <= MAX_DIMENSION && viewWidth * fullHeight * 4 <= MAX_PIXELS;
  // Ab screen page jitni lambi: poora iframe screen ke andar aa jata hai aur poora paint hota hai.
  await metrics(fullHeight, sharp ? 2 : 1);
  await delay(GROW_SETTLE_MS);
  const shot = await devtools.sendCommand('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: viewWidth, height: fullHeight, scale: 1 },
  });
  if (!shot || !shot.data) throw new Error('empty_capture');
  return { png: Buffer.from(shot.data, 'base64'), width: viewWidth, height: fullHeight, scale: sharp ? 2 : 1 };
};

/**
 * `html` = page ka poora document (renderer ka `buildPageDocument`), `width` /
 * `height` = hub mein page ka size (CSS px) — layout usi chaurai par banta hai.
 * Wapsi: `{ png, width, height, scale }`.
 */
const captureVisualPage = async ({ html, width, height }) => {
  if (typeof html !== 'string' || !html.trim()) throw new Error('empty_page');

  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      offscreen: true,
      session: captureSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      disableDialogs: true,
    },
  });

  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('capture_timeout')), TIMEOUT_MS);
  });
  try {
    return await Promise.race([capture(win, { html, width, height }), timeout]);
  } finally {
    clearTimeout(timer);
    try { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); } catch { /* window ja chuki */ }
    if (!win.isDestroyed()) win.destroy();
  }
};

module.exports = { captureVisualPage, freezeViewportUnits };
