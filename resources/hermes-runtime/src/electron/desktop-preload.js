'use strict';

/**
 * Narrow, source-owned bridge for the KnockDesk desktop renderer.
 *
 * Do not expose arbitrary IPC, filesystem access, shell execution, or the
 * legacy renderer's local-license compatibility shims to this new UI.
 */
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function openExternal(target) {
  let parsed;
  try {
    parsed = new URL(String(target));
  } catch {
    return Promise.reject(new Error('Invalid external URL'));
  }
  if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) {
    return Promise.reject(new Error('Unsupported external URL protocol'));
  }
  return ipcRenderer.invoke('knockdesk:open-external', parsed.toString());
}

contextBridge.exposeInMainWorld('knockdeskAPI', Object.freeze({
  getRuntimeState: () => ipcRenderer.invoke('hermes:get-state'),
  startRuntime: () => ipcRenderer.invoke('hermes:start'),
  getHermesPreloadPath: () => ipcRenderer.invoke('hermes:get-preload-path'),
  getAgentTownState: () => ipcRenderer.invoke('agenttown:get-state'),
  startAgentTown: () => ipcRenderer.invoke('agenttown:start'),
  getAgentTownPreloadPath: () => ipcRenderer.invoke('agenttown:get-preload-path'),
  readMemory: () => ipcRenderer.invoke('hermes:memory-read'),
  requestMemory: (instruction) => ipcRenderer.invoke('hermes:memory-request', {
    instruction: String(instruction ?? '').trim(),
  }),
  getSystemInfo: () => ipcRenderer.invoke('get-detailed-system-info'),
  openExternal,
  onRuntimeState: (callback) => subscribe('hermes-state', callback),
  onAgentTownState: (callback) => subscribe('agenttown-state', callback),
  onStartupError: (callback) => subscribe('knockdesk-startup-error', callback),
}));
