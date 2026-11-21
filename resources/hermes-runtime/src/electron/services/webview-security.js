'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Main-frame navigation allowed inside KnockDesk's embedded local services.
 * The embedded dashboards must stay on loopback; external links are forwarded
 * through the host application's safe external-link IPC instead.
 */
function isAllowedLoopbackUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' &&
      LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) &&
      !url.username &&
      !url.password;
  } catch {
    return false;
  }
}

function isAllowedWebviewPreload(preload, allowedPreloads) {
  if (preload === undefined || preload === null || preload === '') return true;

  try {
    const value = String(preload);
    let filename;
    if (/^file:/i.test(value)) {
      filename = fileURLToPath(value);
    } else if (/^[a-zA-Z]:[\\/]/.test(value)) {
      // Windows absolute paths resemble URL schemes (for example C:\\...), so
      // recognize drive-letter paths before rejecting other schemes.
      filename = value;
    } else {
      // Reject non-file schemes rather than treating them as filesystem paths.
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
      filename = value;
    }

    const candidate = path.resolve(filename);
    return allowedPreloads.some((allowed) => path.resolve(allowed) === candidate);
  } catch {
    return false;
  }
}

/**
 * Reapply security-sensitive webPreferences in the main process. Renderer
 * attributes are attacker-controlled if the host renderer is ever compromised.
 */
function hardenWebviewPreferences(preferences) {
  preferences.nodeIntegration = false;
  preferences.nodeIntegrationInSubFrames = false;
  preferences.contextIsolation = true;
  preferences.sandbox = true;
  preferences.webSecurity = true;
  preferences.allowRunningInsecureContent = false;
  preferences.experimentalFeatures = false;
  preferences.webviewTag = false;
  return preferences;
}

module.exports = {
  isAllowedLoopbackUrl,
  isAllowedWebviewPreload,
  hardenWebviewPreferences,
};
