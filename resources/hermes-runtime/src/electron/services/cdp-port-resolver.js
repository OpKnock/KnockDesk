'use strict';

/**
 * Pick a CDP port that we can actually use.
 *
 * The dependencies are injected so the selection policy can be tested without
 * binding real sockets or starting a browser.
 */
async function findUsableCdpPort({
  startPort,
  endPort,
  excludedPorts = [],
  allowReuseExisting = true,
  tryReservePort,
  probeCdpEndpoint,
  logger = console,
} = {}) {
  if (!Number.isInteger(startPort) || !Number.isInteger(endPort) || startPort < 1 || endPort > 65535 || startPort > endPort) {
    throw new TypeError('A valid inclusive CDP port range is required.');
  }
  if (typeof tryReservePort !== 'function' || typeof probeCdpEndpoint !== 'function') {
    throw new TypeError('tryReservePort and probeCdpEndpoint must be functions.');
  }

  const excluded = new Set(excludedPorts);
  for (let port = startPort; port <= endPort; port += 1) {
    if (excluded.has(port)) continue;

    let reservation = null;
    try {
      reservation = await tryReservePort(port);
    } catch (error) {
      logger.warn?.(`[BrowserService] Could not reserve CDP port ${port}: ${error.message}`);
    }
    if (reservation) {
      return { port, reservation, reusedExisting: false };
    }

    let probe;
    try {
      probe = await probeCdpEndpoint(port);
    } catch {
      probe = { reachable: false, chromeFamily: false, browser: null };
    }
    if (probe?.reachable && probe?.chromeFamily && allowReuseExisting) {
      return { port, reservation: null, reusedExisting: true, browser: probe.browser || '(unknown Chrome-family browser)' };
    }

    logger.warn?.(
      `[BrowserService] Skipping occupied CDP port ${port} (${probe?.browser || 'no CDP response'}).`
    );
  }

  throw new Error(
    `No usable Chrome DevTools Protocol port in ${startPort}-${endPort}; every candidate is occupied or excluded.`
  );
}

function isCdpPortConflictError(error) {
  const message = String(error?.message ?? error ?? '');
  return /\bEADDRINUSE\b|address already in use|DevToolsActivePort(?: file)? (?:does not exist|not found)|No usable Chrome DevTools Protocol port|remote debugging port.{0,50}(?:in use|already|bind|listen)/i.test(message);
}

module.exports = { findUsableCdpPort, isCdpPortConflictError };
