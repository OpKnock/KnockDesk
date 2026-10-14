const { ipcMain } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

// IPC surface for the embedded Agent Town (Next.js + Phaser) app.
// The renderer asks the manager to spawn/adopt the local server and reads back
// its URL so the AGENTS panel can load the whole Agent Town UI in a <webview>.
function registerAgentTownHandlers({ getAgentTownManager }) {
  // Absolute file:// URL of the guest preload that installs `window.__knockdeskHost`
  // (the guest→host push channel used to announce finished agent tasks).
  // A <webview>'s `preload` attribute must be a file: URL — this also resolves
  // correctly from inside app.asar in production builds.
  ipcMain.handle('agenttown:get-preload-path', () => {
    try {
      return pathToFileURL(path.join(__dirname, '..', '..', 'agenttown-preload.js')).toString();
    } catch {
      return null;
    }
  });

  ipcMain.handle('agenttown:get-state', () => {
    const mgr = getAgentTownManager();
    return mgr ? mgr.getState() : { state: 'idle', url: null };
  });

  ipcMain.handle('agenttown:start', async () => {
    const mgr = getAgentTownManager();
    if (!mgr) return { state: 'error', error: 'Agent Town manager not initialised' };
    return mgr.start();
  });

  ipcMain.handle('agenttown:restart', async () => {
    const mgr = getAgentTownManager();
    if (!mgr) return { state: 'error', error: 'Agent Town manager not initialised' };
    return mgr.restart();
  });

  ipcMain.handle('agenttown:stop', async () => {
    const mgr = getAgentTownManager();
    if (!mgr) return { state: 'error', error: 'Agent Town manager not initialised' };
    await mgr.stop();
    return mgr.getState();
  });
}

module.exports = { registerAgentTownHandlers };
