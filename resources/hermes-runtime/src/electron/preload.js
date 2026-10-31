const { contextBridge, ipcRenderer, webFrame } = require('electron');

// ── SECURITY: renderer -> main ka darwaza ab allowlisted hai ────────────────
//
// Pehle `invoke(channel)` har channel ko seedha main process tak pohncha deta
// tha. Renderer mein Node integration bhi ON tha. Yani page ke JS mein ek bug
// (koi injected HTML, koi ghalat link) = user ke PC par poora control.
//
// Ab:
//   1. Renderer mein Node nahi (main.js: nodeIntegration false, sandbox default).
//   2. Sirf neeche wale channels invoke/send ho sakte hain — wohi jo main
//      process asal mein handle karta hai. Anjaan channel par saaf error
//      (wohi shakl jo Electron "No handler registered" par deta hai), taake
//      purane call-sites ka catch waise hi chale.
//
// Ye list HAATH SE MAT LIKHO. `npm run ipc:allowlist` electron/ ko scan kar ke
// (ipcMain.handle / ipcMain.on / refuseKeyWrite) block dobara banata hai, aur
// `npm run ipc:check` batata hai ke renderer koi aisa channel to nahi bula
// raha jo list mein nahi. Build (build-production.js) check khud chalata hai.
//
// Renderer -> main ke `on()` (main -> renderer events) par pehra nahi hai:
// sunna koi ikhtiyar nahi deta.

// @generated-ipc-allowlist:start
const INVOKE_CHANNELS = new Set([
    'access-check',
    'access-get-envelope',
    'agent-report-add',
    'agent-reports-mark-delivered',
    'agent-reports-recent',
    'agent-reports-undelivered',
    'agenttown:get-preload-path',
    'agenttown:get-state',
    'agenttown:restart',
    'agenttown:start',
    'agenttown:stop',
    'auth-delete',
    'auth-get-profile',
    'auth-get-stored',
    'auth-logout-device',
    'auth-save',
    'auth-start-callback-server',
    'auth-stop-callback-server',
    'awareness:configure',
    'awareness:log',
    'awareness:screenshot',
    'awareness:snapshot',
    'browser-clear-cookies',
    'browser-clear-storage',
    'browser-click',
    'browser-close',
    'browser-close-tab',
    'browser-download-by-click',
    'browser-drag-drop',
    'browser-emulate-color-scheme',
    'browser-emulate-device',
    'browser-execute-script',
    'browser-extract',
    'browser-fill-form',
    'browser-get-console',
    'browser-get-cookies',
    'browser-get-errors',
    'browser-get-html',
    'browser-get-storage',
    'browser-get-tabs',
    'browser-go-back',
    'browser-go-forward',
    'browser-handle-dialog',
    'browser-highlight',
    'browser-hover',
    'browser-navigate',
    'browser-new-tab',
    'browser-press-key',
    'browser-query-selector',
    'browser-reload',
    'browser-resize-viewport',
    'browser-save-pdf',
    'browser-screenshot',
    'browser-scroll',
    'browser-scroll-into-view',
    'browser-select',
    'browser-set-cookie',
    'browser-set-extra-headers',
    'browser-set-geolocation',
    'browser-set-http-credentials',
    'browser-set-offline',
    'browser-set-storage',
    'browser-snapshot',
    'browser-switch-tab',
    'browser-type',
    'browser-upload-file',
    'browser-wait',
    'browser-wait-download',
    'cancel-codex-login',
    'check-for-updates',
    'clear-history',
    'clipboard-read',
    'clipboard-write',
    'close-info-panel',
    'close-window',
    'computer:configure',
    'computer:result',
    'computer:run',
    'computer:status',
    'computer:stop',
    'desktop-get-active-window',
    'desktop-get-screen-size',
    'desktop-list-windows',
    'desktop-mouse-click',
    'desktop-mouse-drag',
    'desktop-mouse-move',
    'desktop-mouse-toggle',
    'desktop-open-application',
    'desktop-screenshot',
    'desktop-scroll',
    'download-update',
    'facelock:change-pin',
    'facelock:disable',
    'facelock:enroll',
    'facelock:lock-now',
    'facelock:status',
    'facelock:verify-face',
    'facelock:verify-pin',
    'fetch-dashboard-data',
    'get-app-version',
    'get-auto-update-enabled',
    'get-codex-auth-status',
    'get-custom-models',
    'get-detailed-system-info',
    'get-documents-path',
    'get-gemini-token',
    'get-gemini-token-backup',
    'get-groq-token',
    'get-info-panel-data',
    'get-kimi-token',
    'get-notes-path',
    'get-openai-token',
    'get-openrouter-models',
    'get-openrouter-token',
    'get-prefer-direct-gemini',
    'get-processes',
    'get-knockdesk-data-path',
    'get-stored-user',
    'get-sub-agent-config',
    'get-voice-assistant-mode',
    'get-voice-provider',
    'get-wake-word-enabled',
    'hermes:api',
    'hermes:get-connection',
    'hermes:get-preload-path',
    'hermes:get-state',
    'hermes:memory-read',
    'hermes:memory-request',
    'hermes:share-fact',
    'hermes:start',
    'hermes:whatsapp-pair-cancel',
    'hermes:whatsapp-pair-info',
    'hermes:whatsapp-pair-start',
    'hermes:whatsapp-set-phone',
    'hermes:whatsapp-unlink',
    'http-fetch',
    'initialize-vault',
    'install-update',
    'keyboard-press',
    'keyboard-type',
    'kill-process',
    'launch-browser-login-session',
    'license-passed',
    'load-chats',
    'load-contacts',
    'load-dashboard-settings',
    'load-history',
    'load-history-settings',
    'load-imported-folders',
    'load-memories',
    'load-notes',
    'load-tasks',
    'load-user-profile',
    'mcp-add',
    'mcp-list',
    'mcp-remove',
    'mcp-test',
    'memory:append-turns',
    'memory:backup',
    'memory:character-event',
    'memory:character-events',
    'memory:context',
    'memory:detail',
    'memory:due',
    'memory:export',
    'memory:follow-up',
    'memory:forget',
    'memory:forget-query',
    'memory:intention-add',
    'memory:intention-resolve',
    'memory:intentions',
    'memory:list',
    'memory:llm-ready',
    'memory:llm-reply',
    'memory:pin',
    'memory:recall',
    'memory:recall-finish',
    'memory:recall-pack',
    'memory:recall-usage',
    'memory:remember',
    'memory:session-ended',
    'memory:session-turns',
    'memory:sessions',
    'memory:set-busy',
    'memory:set-digest',
    'memory:set-paused',
    'memory:status',
    'memory:update',
    'minimize-window',
    'onboarding:machine-scan',
    'open-external-link',
    'open-info-panel',
    'open-neural-browser',
    'open-vault-folder',
    'payment-claim-status',
    'payment-claim-submit',
    'pick-and-read-files',
    'pick-folder',
    'plan-menu',
    'play-youtube-video',
    'read-bootstrap-files',
    'read-file-content',
    'register-vertex-token',
    'save-auto-update-enabled',
    'save-chats',
    'save-contacts',
    'save-custom-models',
    'save-dashboard-settings',
    'save-gemini-token',
    'save-gemini-token-backup',
    'save-groq-token',
    'save-history',
    'save-history-settings',
    'save-image',
    'save-imported-folders',
    'save-kimi-token',
    'save-lead',
    'save-memories',
    'save-notes',
    'save-openai-token',
    'save-openrouter-token',
    'save-prefer-direct-gemini',
    'save-sub-agent-config',
    'save-tasks',
    'save-user-profile',
    'save-voice-assistant-mode',
    'save-voice-provider',
    'search-files-content',
    'send-notification',
    'send-whatsapp-keyboard',
    'set-wake-word-enabled',
    'skills-delete',
    'skills-get-all',
    'skills-load-content',
    'skills-save',
    'skills-toggle',
    'start-codex-login',
    'knockdesk-cloud-device-key-clear',
    'knockdesk-cloud-device-key-get',
    'knockdesk-cloud-device-key-save',
    'knockdesk-cloud-supabase-config',
    'knockdesk-cloud-token',
  'knockdesk-remote:ensure',
  'knockdesk-remote:hermes-session',
  'knockdesk-remote:inbound',
  'knockdesk-remote:read-file',
  'knockdesk-remote:status',
    'subscription-portal',
    'system-cancel-command',
    'system-exec-command',
    'system-fs-op',
    'system-open',
    'visual-hub-capture',
    'visual-hub-capture-page',
    'web-search',
    'window-control',
    'write-bootstrap-file',
]);
// @generated-ipc-allowlist:end

const isAllowed = (channel) => typeof channel === 'string' && INVOKE_CHANNELS.has(channel);
const blocked = (kind, channel) => {
    const err = new Error(`No handler registered for '${String(channel)}' (blocked by preload allowlist, ${kind})`);
    console.warn('[KnockDesk][ipc]', err.message);
    return err;
};

// ── KNOCKDESK LOCAL-MODE: fully offline, no cloud auth/paywall ───────────
// access-check + auth + cloud token live in compiled main.jsc, so we answer
// here in preload and never hit network. Everything else passes through.
// Forces BYOK mode (license.byok=true, cloud.active=false) so voice uses
// the user's own Gemini key direct (byok-direct) instead of KnockDesk Cloud.
const LOCAL_JWT = 'eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImxvY2FsQGxvY2FsIiwidXNlcl9tZXRhZGF0YSI6eyJmdWxsX25hbWUiOiJMb2NhbCIsIm5hbWUiOiJMb2NhbCJ9LCJleHAiOjQxMDI0NDQ4MDAsImlhdCI6MTcwMDAwMDAwMH0.bG9jYWw';
const LOCAL_EMAIL = 'local@local';
const LOCAL_USER = {
  email: LOCAL_EMAIL, token: LOCAL_JWT, refreshToken: 'local-key',
  approved: true, access: true, valid: true, active: true, allowed: true,
  authorized: true, authenticated: true, granted: true, success: true, ok: true,
  plan: 'lifetime', lifetime: true, name: 'Local',
};
const LOCAL_ENVELOPE = {
  ok: true, success: true, valid: true, access: true, granted: true,
  authorized: true, allowed: true, approved: true, authenticated: true,
  active: true, hasAccess: true, hasPlan: true, subscribed: true,
  accessGranted: true, isValid: true, isActive: true, hasAccessRights: true,
  reason: null, refusalReason: null, error: null, networkError: false,
  access: true, local: true, plan: 'lifetime', lifetime: true,
  plans: ['lifetime'], limits: { plan: 'lifetime', unlimited: true, byok: true },
  license: { plan: 'lifetime', lifetime: true, local: true, byok: true },
  models: [{ id: 'local' }], device: { local: true },
  cloud: { active: false, local: true }, email: LOCAL_EMAIL, periodEnd: null,
};
const LOCAL_FAKE = {
    'access-check': () => Promise.resolve({ ...LOCAL_ENVELOPE }),
    'access-get-envelope': () => Promise.resolve({ ...LOCAL_ENVELOPE }),
    'auth-get-stored': () => Promise.resolve({ ...LOCAL_USER }),
    'get-stored-user': () => Promise.resolve({ ...LOCAL_USER }),
    'auth-save': () => Promise.resolve({ ok: true, success: true, local: true, ...LOCAL_USER }),
    'auth-delete': () => Promise.resolve({ ok: true, success: true, local: true }),
    'auth-logout-device': () => Promise.resolve({ ok: true, success: true, local: true }),
    'auth-get-profile': () => Promise.resolve({ email: LOCAL_EMAIL, name: 'Local', avatarUrl: null }),
    'auth-start-callback-server': () => Promise.resolve({ ok: false, success: false, disabled: true, local: true, error: 'Google login disabled in KnockDesk local mode. Add your own Gemini API key in Settings.' }),
    'auth-stop-callback-server': () => Promise.resolve({ ok: true, success: true, local: true }),
    'launch-browser-login-session': () => Promise.reject(new Error('Browser login disabled in KnockDesk local mode.')),
    'knockdesk-cloud-supabase-config': () => Promise.resolve({ ok: false, success: false, disabled: true, local: true }),
    'knockdesk-cloud-token': () => Promise.resolve({ ok: true, success: true, local: true, token: LOCAL_JWT, gateway: 'http://127.0.0.1:1', baseUrl: 'http://127.0.0.1:1', url: 'http://127.0.0.1:1', email: LOCAL_EMAIL }),
    'knockdesk-cloud-device-key-get': () => Promise.resolve({ ok: true, success: true, local: true, key: 'local', email: LOCAL_EMAIL }),
    'knockdesk-cloud-device-key-save': () => Promise.resolve({ ok: true, success: true, local: true }),
    'knockdesk-cloud-device-key-clear': () => Promise.resolve({ ok: true, success: true, local: true }),
    'license-passed': () => Promise.resolve({ ok: true, success: true, local: true, plan: 'lifetime' }),
    'subscription-portal': () => Promise.reject(new Error('Billing disabled in KnockDesk local mode.')),
    'payment-claim-status': () => Promise.resolve({ ok: true, local: true, claimed: true }),
    'payment-claim-submit': () => Promise.resolve({ ok: true, local: true }),
    'check-for-updates': () => Promise.resolve({ updateAvailable: false, local: true }),
    'download-update': () => Promise.resolve({ ok: true, local: true }),
    'install-update': () => Promise.resolve({ ok: true, local: true }),
    'get-auto-update-enabled': () => Promise.resolve(false),
    'save-auto-update-enabled': () => Promise.resolve({ ok: true, local: true }),
    // ── Universal licence: no plans, no gates — everyone is lifetime-local.
    'plan-menu': () => Promise.resolve({ ok: true, local: true, plan: 'lifetime', lifetime: true, plans: [{ id: 'lifetime', name: 'KnockDesk Lifetime', active: true }] }),
    // ── API key saves: main's compiled saveKeyHandler is gated behind a
    // cloud licence that never loads offline, so it rejects every save.
    // Try main first; if it does not return boolean true, persist the key
    // ourselves via the ungated system-fs-op channel (plain JSON — the
    // app's key reader accepts plain files and auto-migrates them).
    'save-gemini-token': (...a) => kdSaveKey('secret_key.json', ['geminiKey'], ...a),
    'save-gemini-token-backup': (...a) => kdSaveKey('secret_key.json', ['geminiKeyBackup'], ...a),
    'save-groq-token': (...a) => kdSaveKey('groq_key.json', ['groqKey', 'apiKey'], ...a),
    'save-openai-token': (...a) => kdSaveKey('openai_key.json', ['openaiKey', 'apiKey'], ...a),
    'save-openrouter-token': (...a) => kdSaveKey('openrouter_key.json', ['apiKey'], ...a),
    'save-kimi-token': (...a) => kdSaveKey('kimi_key.json', ['kimiKey', 'moonshotKey', 'apiKey'], ...a),
};

// userData dir (cached). get-knockdesk-data-path is a plain ungated getter.
let __kdDataPath = null;
async function kdDataPath() {
    if (__kdDataPath) return __kdDataPath;
    const p = await ipcRenderer.invoke('get-knockdesk-data-path');
    if (typeof p !== 'string' || !p) throw new Error('no data path');
    __kdDataPath = p.replace(/[\\/]+$/, '');
    return __kdDataPath;
}

async function kdSaveKey(file, fields, value) {
    // 1) try the real handler (works if main ever has a licence).
    const mainChannelByFile = {
        'secret_key.json|geminiKey': 'save-gemini-token',
        'secret_key.json|geminiKeyBackup': 'save-gemini-token-backup',
        'groq_key.json|groqKey': 'save-groq-token',
        'openai_key.json|openaiKey': 'save-openai-token',
        'openrouter_key.json|apiKey': 'save-openrouter-token',
        'kimi_key.json|kimiKey': 'save-kimi-token',
    };
    const mainChannel = mainChannelByFile[file + '|' + fields[0]];
    if (mainChannel) {
        try {
            const r = await ipcRenderer.invoke(mainChannel, value);
            if (r === true) return true;
        } catch {}
    }
    // 2) fallback: write the key file ourselves (merge with existing).
    try {
        const dir = await kdDataPath();
        const full = dir + '\\' + file;
        const v = String(value ?? '').trim();
        let current = {};
        try {
            const raw = await ipcRenderer.invoke('system-fs-op', { operation: 'read-file', path: full });
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !parsed.enc) current = parsed;
        } catch {}
        const next = { ...current, updatedAt: Date.now() };
        for (const k of fields) next[k] = v;
        const ok = await ipcRenderer.invoke('system-fs-op', { operation: 'write-file', path: full, content: JSON.stringify(next, null, 2) });
        if (ok === true) return true;
    } catch {}
    return false;
}

contextBridge.exposeInMainWorld('electronAPI', {
    // ... existing apis ...
    onUpdateLog: (callback) => ipcRenderer.on('update-log', (_event, value) => callback(value)),
    // ... existing apis ...
    setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
    getZoomFactor: () => webFrame.getZoomFactor(),
    invoke: (channel, ...args) => {
        if (Object.prototype.hasOwnProperty.call(LOCAL_FAKE, channel)) return LOCAL_FAKE[channel](...args);
        return isAllowed(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(blocked('invoke', channel));
    },
    send: (channel, ...args) => {
        if (isAllowed(channel)) ipcRenderer.send(channel, ...args);
        else blocked('send', channel);
    },
    on: (channel, callback) => {
        if (typeof channel !== 'string' || typeof callback !== 'function') return () => {};
        const subscription = (_event, ...args) => callback(...args);
        ipcRenderer.on(channel, subscription);
        return () => ipcRenderer.removeListener(channel, subscription);
    },
    // Auto-update APIs — neutered: no update server in local builds, and the
    // broken-feed error toast ("Update failed") is swallowed, not shown.
    onUpdateStatus: (_callback) => () => {},
    installUpdate: () => Promise.resolve({ ok: true, local: true }),
    checkForUpdates: () => Promise.resolve({ updateAvailable: false, local: true }),
});
