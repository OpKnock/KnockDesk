// ═══════════════════════════════════════════════════════════════
//  CDP Endpoint Shim
//
//  Hermes' browser tools honour a `BROWSER_CDP_URL` override: when it is
//  set they skip BOTH their cloud providers and their own headless Chromium
//  launcher, and attach to that Chrome DevTools endpoint instead
//  (see hermes-agent-main/tools/browser_tool.py → _get_cdp_override).
//
//  We want them to attach to *KnockDesk's* bundled Chromium — the one that is
//  already visible (headless: false) and already keeps logins in a
//  persistent profile. Two things stand in the way:
//
//    1. That Chromium is launched lazily, so nothing is listening until
//       some tool actually needs a browser.
//    2. Its CDP port is chosen dynamically at launch (9222-9252), so there
//       is no fixed address to hand Hermes ahead of time.
//
//  This shim is the fixed address, and it is the browser's front door:
//  Hermes gets `ws://127.0.0.1:<shim>/devtools/browser/knockdesk ai`, a URL that
//  is valid before Chromium exists. Nothing happens until a CDP client
//  actually opens that websocket — THAT is the moment a tool needs a
//  browser, so that is where we launch Chromium and then splice the socket
//  through to the real endpoint.
//
//  Why a websocket URL and not a discovery URL (http://…):
//
//    Hermes resolves discovery-style overrides by fetching /json/version.
//    It does that not only when a tool runs, but also from
//    `check_browser_requirements()` — the registry's availability probe,
//    which runs during tool-schema assembly at every Hermes startup. A shim
//    that launched Chromium on discovery therefore popped a browser window
//    open the moment the app booted, with no task behind it. Hermes returns
//    any URL containing `/devtools/browser/` untouched, without a probe
//    (browser_tool.py → _resolve_cdp_override), so handing it one keeps the
//    availability check free and moves the launch to first real use.
//
//  The discovery routes below are kept for other CDP clients, and they too
//  report the lazy endpoint rather than launching anything.
//
//  Hermes itself is not modified — KnockDesk only sets the env var it already
//  looks for, and every Hermes child process (dashboard, `hermes -z`
//  one-shots, Agent Town's `hermes chat`) inherits it via `{...process.env}`.
// ═══════════════════════════════════════════════════════════════

const http = require('http');
const net = require('net');

const SHIM_PORT_START = 9333;
const SHIM_PORT_END = 9353;

// The stable browser endpoint we advertise. Chromium's own websocket path
// carries a GUID that changes on every launch; this one never does, so a
// client that reconnects after the user closed the browser by hand lands
// back here and simply reopens it.
const LAZY_BROWSER_PATH = '/devtools/browser/knockdesk ai';

// A fresh PC's first-ever Chromium start can be very slow (AV scans the
// whole binary while the profile is created), and browser-manager now allows
// it 120s. Waiting most of that here costs nothing: if the CDP client hangs
// up sooner on its own connect timeout, the launch still finishes in the
// background and the retry connects instantly.
const LAUNCH_TIMEOUT_MS = 60000;
const UPSTREAM_TIMEOUT_MS = 2500;

// Discovery routes only. The shim must never serve the /json/new|close|activate
// mutation routes — a localhost HTTP server that lets a page create and drive
// arbitrary tabs is a remote-code-execution surface.
const ALLOWED_PATHS = new Set(['/json/version', '/json', '/json/list']);

let server = null;
let browserWsUrl = null;   // what Hermes is pointed at
let launchPromise = null;

// Collapse concurrent connects into one launch. `browserService.launch()` is
// already a no-op when the browser is alive, but parallel Hermes tool calls
// would otherwise each pay the aliveness check while Chromium is still
// coming up.
function ensureBrowserLaunched() {
    if (launchPromise) return launchPromise;
    const { browserService } = require('./browser-manager');
    launchPromise = Promise.resolve()
        .then(() => browserService.launch())
        .finally(() => { launchPromise = null; });
    return launchPromise;
}

function browserIsRunning() {
    try {
        const { browserService } = require('./browser-manager');
        return browserService.isRunning();
    } catch {
        return false;
    }
}

function withTimeout(promise, ms, message) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Fetch a discovery route from the real Chromium CDP endpoint.
function fetchFromChromium(port, pathname) {
    return new Promise((resolve, reject) => {
        const req = http.get(
            { host: '127.0.0.1', port, path: pathname, timeout: UPSTREAM_TIMEOUT_MS },
            (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => resolve({
                    status: res.statusCode || 200,
                    contentType: res.headers['content-type'] || 'application/json',
                    body,
                }));
            }
        );
        req.on('timeout', () => { req.destroy(); reject(new Error(`CDP probe on port ${port} timed out`)); });
        req.on('error', reject);
    });
}

// Chromium's current browser-level websocket path (the GUID changes per launch).
async function chromiumBrowserWsPath(port) {
    const { body } = await fetchFromChromium(port, '/json/version');
    const wsUrl = String(JSON.parse(body).webSocketDebuggerUrl || '');
    if (!wsUrl) throw new Error('Chromium did not report a webSocketDebuggerUrl');
    return new URL(wsUrl).pathname;
}

// Only answer requests addressed to loopback. The listener is already bound
// to 127.0.0.1, but an explicit Host check also closes DNS-rebinding, which
// is how CDP endpoints normally get abused from a web page.
function hostIsLoopback(hostHeader) {
    if (!hostHeader) return false;
    const host = String(hostHeader).split(':')[0].toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

function sendJsonError(res, status, message) {
    const body = JSON.stringify({ error: message });
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

function sendJson(res, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

// ─── Discovery (never launches) ─────────────────────────────────────────
//
// Answers with the lazy endpoint whether or not Chromium is up, so a client
// that discovers here always gets a URL it can connect to — and connecting
// is what starts the browser.
async function handleRequest(req, res) {
    if (!hostIsLoopback(req.headers.host)) {
        return sendJsonError(res, 403, 'Forbidden');
    }

    let pathname;
    try {
        pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch {
        return sendJsonError(res, 400, 'Bad request');
    }

    if (req.method !== 'GET' || !ALLOWED_PATHS.has(pathname)) {
        return sendJsonError(res, 404, 'Not found');
    }

    if (!browserIsRunning()) {
        // Nothing to report yet, and asking is not a reason to open a browser.
        if (pathname === '/json/version') {
            return sendJson(res, {
                Browser: 'Chrome/KnockDesk (not started)',
                'Protocol-Version': '1.3',
                webSocketDebuggerUrl: browserWsUrl,
            });
        }
        return sendJson(res, []);   // /json and /json/list: no targets yet
    }

    const { getCdpPort } = require('./browser-manager');
    const cdpPort = getCdpPort();

    try {
        const upstream = await fetchFromChromium(cdpPort, pathname);
        if (pathname === '/json/version') {
            // Hand out OUR websocket, not Chromium's: clients must come back
            // through the shim so the browser can be relaunched under them if
            // it was closed in the meantime.
            const payload = JSON.parse(upstream.body);
            payload.webSocketDebuggerUrl = browserWsUrl;
            return sendJson(res, payload);
        }
        res.writeHead(upstream.status, { 'Content-Type': upstream.contentType });
        res.end(upstream.body);
    } catch (err) {
        console.error(`[CDP Shim] Could not reach Chromium CDP on ${cdpPort}:`, err.message);
        sendJsonError(res, 502, `Chromium CDP unreachable on port ${cdpPort}`);
    }
}

// ─── Connect (this is where the browser actually opens) ─────────────────
//
// A CDP client opening the websocket is the one unambiguous signal that a
// tool is about to drive a browser. Launch Chromium, then hand the socket
// straight through to it: after the handshake the shim is a byte pipe, it
// neither parses nor rewrites CDP traffic.
async function handleUpgrade(req, clientSocket, head) {
    const fail = (line, reason) => {
        console.warn('[CDP Shim] Rejected websocket upgrade:', reason);
        // Same file browser-manager writes its launch diagnostics to — one
        // place to look on a machine where the console is invisible.
        try { require('./browser-manager').appendBrowserLog(`shim reject (${line}): ${reason}`); } catch { /* ignore */ }
        try {
            // Carry the reason in the body: CDP clients only surface the status
            // line ("503 Service Unavailable"), but anyone probing with curl —
            // or a client that reads the response — gets the actual cause
            // (e.g. the full Playwright launch error) instead of a bare code.
            const body = `CDP shim: ${reason}\n`;
            clientSocket.write(
                `HTTP/1.1 ${line}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
            );
        } catch { /* socket gone */ }
        clientSocket.destroy();
    };

    if (!hostIsLoopback(req.headers.host)) return fail('403 Forbidden', 'non-loopback Host');

    // Real CDP clients (Playwright, agent-browser, chrome-remote-interface) do
    // not send Origin; browsers always do. Refusing it keeps a malicious page
    // from driving the user's logged-in browser through this port.
    if (req.headers.origin) return fail('403 Forbidden', `Origin header present (${req.headers.origin})`);

    let pathname;
    try {
        pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch {
        return fail('400 Bad Request', 'unparseable request URL');
    }
    if (!pathname.startsWith('/devtools/')) return fail('404 Not Found', `path ${pathname}`);

    const { getCdpPort, appendBrowserLog } = require('./browser-manager');
    const connectStarted = Date.now();
    let cdpPort;
    let targetPath;
    try {
        await withTimeout(ensureBrowserLaunched(), LAUNCH_TIMEOUT_MS, 'Chromium did not come up in time');
        cdpPort = getCdpPort();
        // Our advertised path is a placeholder — swap in the GUID of the
        // Chromium that is running *now*. Page-level paths pass through as-is.
        targetPath = pathname.startsWith('/devtools/browser/')
            ? await chromiumBrowserWsPath(cdpPort)
            : req.url;
    } catch (err) {
        console.error('[CDP Shim] Browser unavailable for CDP connect:', err.message);
        return fail('503 Service Unavailable', `browser unavailable: ${err.message}`);
    }
    try { appendBrowserLog(`shim connect OK in ${Date.now() - connectStarted}ms (port ${cdpPort})`); } catch { /* ignore */ }

    const upstream = net.connect(cdpPort, '127.0.0.1', () => {
        // Replay the client's handshake verbatim against the real endpoint —
        // only the path and Host change. Chromium computes the accept key from
        // the client's own Sec-WebSocket-Key, so the handshake it sends back is
        // the one the client is waiting for.
        const lines = [`GET ${targetPath} HTTP/1.1`];
        for (const [name, value] of Object.entries(req.headers)) {
            if (name.toLowerCase() === 'host') continue;
            for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
        }
        lines.push(`Host: 127.0.0.1:${cdpPort}`);
        upstream.write(lines.join('\r\n') + '\r\n\r\n');
        if (head && head.length) upstream.write(head);

        clientSocket.setNoDelay(true);
        upstream.setNoDelay(true);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
        console.log(`[CDP Shim] CDP client attached to Chromium (port ${cdpPort}, ${targetPath}).`);
    });

    const teardown = (who) => (err) => {
        if (err) console.warn(`[CDP Shim] CDP tunnel ${who} error:`, err.message);
        clientSocket.destroy();
        upstream.destroy();
    };
    upstream.on('error', teardown('upstream'));
    clientSocket.on('error', teardown('client'));
    upstream.on('close', () => clientSocket.destroy());
    clientSocket.on('close', () => upstream.destroy());
}

function listenOn(port) {
    return new Promise((resolve) => {
        const candidate = http.createServer((req, res) => {
            handleRequest(req, res).catch((err) => {
                console.error('[CDP Shim] Unhandled error:', err.message);
                try { sendJsonError(res, 500, 'Internal error'); } catch { /* socket gone */ }
            });
        });
        candidate.on('upgrade', (req, socket, head) => {
            handleUpgrade(req, socket, head).catch((err) => {
                console.error('[CDP Shim] Unhandled upgrade error:', err.message);
                socket.destroy();
            });
        });
        candidate.once('error', () => resolve(null));
        candidate.listen(port, '127.0.0.1', () => resolve(candidate));
    });
}

/**
 * Start the shim and return the CDP URL Hermes should be pointed at.
 * Idempotent — a second call returns the already-running shim's URL.
 */
async function startCdpShim() {
    if (browserWsUrl) return browserWsUrl;

    const override = parseInt(process.env.STONIC_CDP_SHIM_PORT || '', 10);
    const ports = Number.isInteger(override) && override > 0
        ? [override]
        : Array.from(
            { length: SHIM_PORT_END - SHIM_PORT_START + 1 },
            (_, i) => SHIM_PORT_START + i
        );

    for (const port of ports) {
        const bound = await listenOn(port);
        if (bound) {
            server = bound;
            browserWsUrl = `ws://127.0.0.1:${port}${LAZY_BROWSER_PATH}`;
            console.log(`[CDP Shim] Listening on 127.0.0.1:${port} — browser opens on first CDP connect.`);
            return browserWsUrl;
        }
    }

    throw new Error(`No free port for the CDP shim in ${SHIM_PORT_START}-${SHIM_PORT_END}`);
}

function stopCdpShim() {
    if (server) {
        try { server.close(); } catch { /* already closed */ }
        server = null;
        browserWsUrl = null;
    }
}

module.exports = { startCdpShim, stopCdpShim };
