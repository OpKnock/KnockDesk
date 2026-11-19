const { ipcMain } = require('electron');

// IPC surface for Face Lock (FaceLockManager — services/facelock-manager.js).
//
// The renderer does the seeing (camera, face mesh, the 128-number face print);
// every decision is made here. Stored face prints and the PIN hash never leave
// this process, and the lock only opens on a successful verify below.
//
// Only the MAIN window may call these: the player / info / browser sub-windows
// share the preload, and a locked app must not be unlockable from one of them.
function registerFaceLockHandlers({ getFaceLockManager }) {
  const withManager = (fn) => (event, args = {}) => {
    const mgr = getFaceLockManager();
    if (!mgr) return { ok: false, reason: 'unavailable' };
    const win = mgr.getWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return { ok: false, reason: 'forbidden' };
    return fn(mgr, args || {});
  };

  // Status is read-only and every window needs it (voice must stay quiet in a
  // sub-window too), so it skips the main-window check.
  ipcMain.handle('facelock:status', () => {
    const mgr = getFaceLockManager();
    return mgr ? mgr.status() : { supported: false, enabled: false, locked: false };
  });

  ipcMain.handle('facelock:verify-face', withManager((mgr, args) => mgr.verifyFace(args)));
  ipcMain.handle('facelock:verify-pin', withManager((mgr, args) => mgr.verifyPin(args)));
  ipcMain.handle('facelock:enroll', withManager((mgr, args) => mgr.enroll(args)));
  ipcMain.handle('facelock:change-pin', withManager((mgr, args) => mgr.changePin(args)));
  ipcMain.handle('facelock:disable', withManager((mgr, args) => mgr.disable(args)));
  ipcMain.handle('facelock:lock-now', withManager((mgr) => ({ ok: mgr.lock('manual'), status: mgr.status() })));
}

module.exports = { registerFaceLockHandlers };
