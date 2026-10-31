/**
 * Preload for the Agent Town <webview> guest page (agent-town-main).
 *
 * Its ONLY job is to give the guest a one-way push channel back to the host
 * renderer: `window.__knockdeskHost.notify(payload)` → `ipc-message` event on the
 * <webview> element (see src/components/modules/AgentTownHost.tsx).
 *
 * Why: the existing `window.__agentTownBridge` is request/response only — the
 * host asks, the guest answers. When an agent FINISHES a task the guest needs to
 * speak first, so the voice assistant can announce the result without being
 * asked. `ipcRenderer.sendToHost` is Electron's native guest?host channel.
 *
 * Nothing is exposed in the other direction; the guest cannot invoke IPC on the
 * main process. Agent Town running standalone in a browser simply has no
 * `__knockdeskHost` and degrades to the previous pull-only behaviour.
 */

const { contextBridge, ipcRenderer } = require('electron');

const hostApi = {
  version: 1,
  /** Fire-and-forget. Returns false if the channel is unavailable. */
  notify(payload) {
    try {
      ipcRenderer.sendToHost('agent-town-event', payload);
      return true;
    } catch (err) {
      console.warn('[KnockDeskHost] notify failed:', err);
      return false;
    }
  },
};

// contextIsolation is the default for <webview>; fall back to a direct window
// assignment if the guest was attached with isolation disabled.
try {
  contextBridge.exposeInMainWorld('__knockdeskHost', hostApi);
} catch {
  window.__knockdeskHost = hostApi;
}
