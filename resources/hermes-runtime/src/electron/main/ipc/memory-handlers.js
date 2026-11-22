const { ipcMain, BrowserWindow, dialog } = require('electron');
const { LlmRelay } = require('../../services/memory/llm-relay');

// Memory Core (KnockDesk ki apni yaadash) ke IPC handlers.
//
// Service getter se aati hai — wajah wohi jo baqi modules mein hai: handlers
// window banne se pehle register hote hain, service baad mein banti hai.
//
// Har handler ka jawab hamesha ek object hai aur kabhi throw nahi karta:
// yaadash band ho (driver na mila, file kharab, kill switch) to
// `{ ok:false, enabled:false, reason }` jata hai aur renderer purane raaste par
// chala jata hai. App yaadash ki wajah se kabhi nahi rukti.

/** Renderer ko khabar: yaadash badli (Yaadash page khud ko taaza kar le). */
function broadcast(channel, payload) {
  let delivered = false;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try { win.webContents.send(channel, payload); delivered = true; } catch { /* window band ho rahi hai */ }
  }
  return delivered;
}

function registerMemoryHandlers({ getMemoryService, getHermesManager }) {
  /**
   * Hermes ki do files (USER.md, MEMORY.md), jaisi is waqt hain. Recall Agent ko
   * SAARI yaadash jati hai, aur ye do files bhi us ka hissa hain. Hermes na ho
   * ya file na mile to dono khali — ye ghalti nahi.
   */
  const hermesNotes = () => {
    try {
      const mgr = typeof getHermesManager === 'function' ? getHermesManager() : null;
      const files = mgr ? mgr.readMemoryFiles() : null;
      if (files && files.available) return { user: files.user || '', memory: files.memory || '' };
    } catch { /* Hermes install nahi / file band */ }
    return { user: '', memory: '' };
  };

  // Nichor ka LLM call renderer chalata hai — wajah llm-relay.js ke sar par.
  const relay = new LlmRelay({ send: (payload) => broadcast('memory:llm-request', payload) });
  let wired = null;

  const service = () => {
    const svc = getMemoryService();
    if (svc && wired !== svc) {
      wired = svc;
      svc.on('changed', (info) => broadcast('memory:event', info));
    }
    return svc;
  };

  const call = (fn) => async (_event, payload) => {
    const svc = service();
    if (!svc) return { ok: false, enabled: false, reason: 'not_initialised' };
    try {
      return await fn(svc, payload && typeof payload === 'object' ? payload : {});
    } catch (err) {
      return { ok: false, reason: 'error', error: String(err && err.message ? err.message : err).slice(0, 200) };
    }
  };

  ipcMain.handle('memory:status', call((s) => s.status()));

  // ── baat-cheet ──
  ipcMain.handle('memory:append-turns', call((s, p) => s.appendTurns(p)));
  ipcMain.handle('memory:session-ended', call((s, p) => s.sessionEnded(p)));
  // Voice chal rahi ho to nichor rukta hai (bolte waqt koi bhaari kaam nahi).
  ipcMain.handle('memory:set-busy', call((s, p) => { s.setBusy(p.busy === true); return { ok: true }; }));

  // ── yaad rakhna / bhoolna / dhoondna ──
  ipcMain.handle('memory:remember', call((s, p) => s.remember(p)));
  ipcMain.handle('memory:forget-query', call((s, p) => s.forgetByQuery(p)));
  ipcMain.handle('memory:follow-up', call((s, p) => s.followUp(p)));
  ipcMain.handle('memory:recall', call((s, p) => s.recall(p)));
  // Recall Agent: prompt yahan banta hai, model renderer bulata hai, jawab ki
  // jaanch phir yahan (services/memory/recall-agent.js).
  ipcMain.handle('memory:recall-pack', call((s, p) => s.recallPack({ ...p, notes: hermesNotes() })));
  ipcMain.handle('memory:recall-finish', call((s, p) => s.recallFinish(p)));
  ipcMain.handle('memory:recall-usage', call((s, p) => s.recallUsage({ ...p, notes: hermesNotes() })));
  ipcMain.handle('memory:context', call((s, p) => s.contextBlock(p)));
  ipcMain.handle('memory:due', call((s, p) => s.dueIntentions(p)));

  // ── Yaadash page ──
  ipcMain.handle('memory:list', call((s, p) => s.listMemories(p)));
  ipcMain.handle('memory:detail', call((s, p) => s.memoryDetail(Number(p.id))));
  ipcMain.handle('memory:update', call((s, p) => s.updateMemory(Number(p.id), p.patch)));
  ipcMain.handle('memory:pin', call((s, p) => s.setPinned(Number(p.id), p.pinned === true)));
  ipcMain.handle('memory:forget', call((s, p) => s.forgetMemory(Number(p.id), { hard: p.hard === true })));
  ipcMain.handle('memory:intentions', call((s, p) => s.listIntentions(p)));
  ipcMain.handle('memory:intention-add', call((s, p) => s.addIntention(p)));
  ipcMain.handle('memory:intention-resolve', call((s, p) => s.resolveIntention(Number(p.id), p.status)));
  ipcMain.handle('memory:sessions', call((s, p) => s.listSessions(p)));
  ipcMain.handle('memory:session-turns', call((s, p) => s.sessionTurns(String(p.sessionKey || ''), p)));
  ipcMain.handle('memory:set-paused', call((s, p) => s.setPaused(p.paused === true)));
  ipcMain.handle('memory:set-digest', call((s, p) => s.setDigestEnabled(p.enabled === true)));
  ipcMain.handle('memory:backup', call((s) => s.backup()));
  ipcMain.handle('memory:export', call(async (s) => {
    const stamp = new Date().toISOString().slice(0, 10);
    const picked = await dialog.showSaveDialog({
      title: 'Export memory',
      defaultPath: `knockdesk-memory-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (picked.canceled || !picked.filePath) return { ok: false, reason: 'cancelled' };
    return s.exportTo(picked.filePath);
  }));

  // ── character ki taraf ka record (Awareness) ──
  ipcMain.handle('memory:character-event', call((s, p) => s.characterEvent(p)));
  ipcMain.handle('memory:character-events', call((s, p) => s.characterEvents(p)));

  // ── nichor ka LLM (renderer chalata hai) ──
  ipcMain.handle('memory:llm-ready', call((s, p) => {
    if (p.ready === true) {
      s.setLlm((req) => relay.request(req));
    } else {
      s.setLlm(null);
      relay.cancelAll('no_llm');
    }
    return { ok: true };
  }));
  ipcMain.handle('memory:llm-reply', call((_s, p) => ({ ok: relay.resolve(p) })));
}

module.exports = { registerMemoryHandlers };
