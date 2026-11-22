'use strict';

/**
 * KnockDesk one-time storage migration.
 *
 * The persona, character, and voice preferences used to live under
 * STONIC_* localStorage keys. The app now reads and writes the KNOCKDESK_*
 * names. This runs once at first paint and copies each old value to the new
 * key when the new key does not exist yet, so an existing user keeps their
 * persona, characters, voice choice, and the rest instead of being reset.
 *
 * It deliberately does not delete the old keys: leaving them costs a few
 * hundred bytes and keeps a downgrade from losing data.
 * KNOCKDESK_SKIP_STORAGE_MIGRATION=1 disables it (the same hatch the launch
 * shim uses, honoured here for symmetry).
 */

(function migrateStorage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (typeof process !== 'undefined' && process.env && process.env.KNOCKDESK_SKIP_STORAGE_MIGRATION === '1') return;

    var PREFIX = 'STONIC_';
    var NEW_PREFIX = 'KNOCKDESK_';
    var MARKER = 'knockdesk_storage_migrated_v1';
    var store = window.localStorage;

    if (store.getItem(MARKER) === '1') return;

    var moved = 0;
    var kept = [];
    for (var i = 0; i < store.length; i++) {
      var key = store.key(i);
      if (!key || key.indexOf(PREFIX) !== 0) continue;
      var value = store.getItem(key);
      if (value === null) continue;
      var next = NEW_PREFIX + key.slice(PREFIX.length);
      if (store.getItem(next) === null) {
        store.setItem(next, value);
        moved++;
      }
      kept.push(key);
    }

    store.setItem(MARKER, '1');
    if (moved || kept.length) {
      console.log('[KnockDesk] storage migrated: ' + moved + ' value(s) moved to the new keys, '
        + kept.length + ' legacy key(s) found');
    }
  } catch (err) {
    // A full or blocked storage must never break first paint.
    try { console.warn('[KnockDesk] storage migration skipped:', (err && err.message) || err); } catch (e) {}
  }
})();
