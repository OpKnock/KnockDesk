/**
 * Guest preload for the embedded Hermes dashboard <webview>.
 *
 * Hermes' Channels page offers a "Set up with QR" button for Telegram but none
 * for WhatsApp — its WhatsApp pairing lives in the interactive `hermes whatsapp`
 * CLI, which draws a QR into a terminal a packaged app does not have. KnockDesk
 * injects that button (see HermesFrame's WHATSAPP_QR_SCRIPT) and this preload
 * is the only thing the injected code needs from the host: a way to say "the
 * user clicked it".
 *
 * `ipcRenderer.sendToHost` is Electron's native guest→host channel; the host
 * receives it as an `ipc-message` event on the <webview>. Nothing is exposed
 * beyond that single, argument-less signal, and nothing is read back — the
 * dashboard's own pages are untouched.
 *
 * Hermes' source is never modified. Its DOM is decorated from the outside, the
 * same way KnockDesk already restyles it with insertCSS.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__knockdeskHermesHost', {
    openWhatsAppPair: () => {
        try {
            ipcRenderer.sendToHost('knockdesk ai:whatsapp-pair');
        } catch { /* host went away */ }
    },
    // Guaranteed external-link opener, independent of the finicky <webview>
    // `allowpopups` attribute. HermesFrame's injected patch routes the dashboard's
    // window.open("_blank") and <a target="_blank"> clicks here → host →
    // shell.openExternal (system browser). See EXTERNAL_LINK_SCRIPT in HermesFrame.
    openExternal: (url) => {
        try {
            if (typeof url === 'string' && url) {
                ipcRenderer.sendToHost('knockdesk ai:open-external', url);
            }
        } catch { /* host went away */ }
    },
});
