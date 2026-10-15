'use strict';

/**
 * Creates a single-flight async initializer that can be retried after failure.
 *
 * Concurrent callers share the same in-flight promise. A rejected attempt
 * clears the cached promise so a later caller can try again; a successful
 * attempt remains cached for the lifetime of this initializer.
 *
 * @template T
 * @param {(...args: any[]) => Promise<T> | T} initialize
 * @returns {(...args: any[]) => Promise<T>}
 */
function createRetryableInitializer(initialize) {
  if (typeof initialize !== 'function') {
    throw new TypeError('initialize must be a function');
  }

  let currentPromise = null;

  return (...args) => {
    if (currentPromise) return currentPromise;

    let attempt;
    attempt = Promise.resolve()
      .then(() => initialize(...args))
      .catch((error) => {
        // Do not clear a newer attempt should this implementation evolve to
        // allow explicit cancellation or replacement in the future.
        if (currentPromise === attempt) currentPromise = null;
        throw error;
      });

    currentPromise = attempt;
    return attempt;
  };
}

module.exports = { createRetryableInitializer };
