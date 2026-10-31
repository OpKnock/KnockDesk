const { ipcMain } = require('electron');

// IPC surface for the Agent S3 computer-use sidecar (ComputerManager).
// The renderer's `computer_task` tools and the takeover HUD talk to this;
// live progress comes back on the `computer:event` channel.
function registerComputerHandlers({ getComputerManager }) {
  const withManager = (fn) => (_event, args = {}) => {
    const mgr = getComputerManager();
    if (!mgr) return { ok: false, error: 'Computer manager not initialised' };
    return fn(mgr, args || {});
  };

  // Renderer resolves the cloud gateway + device key (it owns the login
  // session) and hands them here so the sidecar can call the models.
  ipcMain.handle('computer:configure', withManager((mgr, args) => mgr.configure(args)));
  ipcMain.handle('computer:status', withManager((mgr) => ({ ok: true, ...mgr.getStatus() })));
  ipcMain.handle('computer:run', withManager((mgr, args) => mgr.runTask({ ...args, source: args.source || 'voice' })));
  ipcMain.handle('computer:stop', withManager((mgr, args) => mgr.stop(args.taskId)));
  ipcMain.handle('computer:result', withManager((mgr, args) => {
    const result = mgr.getResult(args.taskId);
    return result ? { ok: true, done: true, result } : { ok: true, done: false, task: mgr.getStatus().task };
  }));
}

module.exports = { registerComputerHandlers };
