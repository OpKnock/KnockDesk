const { ipcMain } = require('electron');

// IPC surface for Awareness (AwarenessManager — the "eyes" of Proactive
// Presence). The brain lives in the renderer (src/lib/awareness); it switches
// the senses on/off here and asks for a snapshot or a screenshot when it needs
// one. Live signals (came back, unlocked, woke up, tick) go the other way on
// the `awareness:event` channel.
function registerAwarenessHandlers({ getAwarenessManager }) {
  const withManager = (fn) => (_event, args = {}) => {
    const mgr = getAwarenessManager();
    if (!mgr) return { ok: false, error: 'Awareness manager not initialised' };
    return fn(mgr, args || {});
  };

  ipcMain.handle('awareness:configure', withManager((mgr, args) => mgr.configure({ enabled: args.enabled === true })));
  ipcMain.handle('awareness:snapshot', withManager((mgr) => mgr.snapshot()));
  ipcMain.handle('awareness:screenshot', withManager((mgr) => mgr.captureScreen()));
  // The brain's decisions ("stayed quiet", "speaking up", failures) — written
  // to userData/awareness/awareness.log so they can be read after the fact.
  ipcMain.handle('awareness:log', withManager((mgr, args) => mgr.writeLog(args)));
}

module.exports = { registerAwarenessHandlers };
