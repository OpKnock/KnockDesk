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
  getRuntimeState: () => ipcRenderer.invoke('knockdesk:runtime:get-state'),
  startRuntime: () => ipcRenderer.invoke('knockdesk:runtime:start'),
  getHermesPreloadPath: () => ipcRenderer.invoke('knockdesk:runtime:preload'),
  getAgentTownState: () => ipcRenderer.invoke('knockdesk:agenttown:get-state'),
  startAgentTown: () => ipcRenderer.invoke('knockdesk:agenttown:start'),
  getAgentTownPreloadPath: () => ipcRenderer.invoke('knockdesk:agenttown:preload'),
  readMemory: () => ipcRenderer.invoke('knockdesk:memory:read'),
  requestMemory: (instruction) => ipcRenderer.invoke('knockdesk:memory:update', {
    instruction: String(instruction ?? '').trim(),
  }),
  getSystemInfo: () => ipcRenderer.invoke('knockdesk:system:info'),
  openExternal,
  onRuntimeState: (callback) => subscribe('hermes-state', callback),
  onAgentTownState: (callback) => subscribe('agenttown-state', callback),
  onStartupError: (callback) => subscribe('knockdesk-startup-error', callback),
}));
