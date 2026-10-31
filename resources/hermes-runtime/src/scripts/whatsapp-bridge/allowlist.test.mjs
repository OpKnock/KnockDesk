import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import {
  collectSelfIdentifiers,
  expandWhatsAppIdentifiers,
  matchesAllowedUser,
  matchesSelfIdentifier,
  normalizeWhatsAppIdentifier,
  parseAllowedUsers,
} from './allowlist.js';

test('normalizeWhatsAppIdentifier strips jid syntax and plus prefix', () => {
  assert.equal(normalizeWhatsAppIdentifier('+19175395595@s.whatsapp.net'), '19175395595');
  assert.equal(normalizeWhatsAppIdentifier('267383306489914@lid'), '267383306489914');
  assert.equal(normalizeWhatsAppIdentifier('19175395595:12@s.whatsapp.net'), '19175395595');
});

test('expandWhatsAppIdentifiers resolves phone and lid aliases from session files', () => {
  const sessionDir = mkdtempSync(path.join(os.tmpdir(), 'hermes-wa-allowlist-'));

  try {
    writeFileSync(path.join(sessionDir, 'lid-mapping-19175395595.json'), JSON.stringify('267383306489914'));
    writeFileSync(path.join(sessionDir, 'lid-mapping-267383306489914_reverse.json'), JSON.stringify('19175395595'));

    const aliases = expandWhatsAppIdentifiers('267383306489914@lid', sessionDir);
    assert.deepEqual([...aliases].sort(), ['19175395595', '267383306489914']);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('matchesAllowedUser accepts mapped lid sender when allowlist only contains phone number', () => {
  const sessionDir = mkdtempSync(path.join(os.tmpdir(), 'hermes-wa-allowlist-'));

  try {
    writeFileSync(path.join(sessionDir, 'lid-mapping-19175395595.json'), JSON.stringify('267383306489914'));
    writeFileSync(path.join(sessionDir, 'lid-mapping-267383306489914_reverse.json'), JSON.stringify('19175395595'));

    const allowedUsers = parseAllowedUsers('+19175395595');
    assert.equal(matchesAllowedUser('267383306489914@lid', allowedUsers, sessionDir), true);
    assert.equal(matchesAllowedUser('188012763865257@lid', allowedUsers, sessionDir), false);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('collectSelfIdentifiers resolves the phone JID of a LID-only socket', () => {
  // The bug this guards: `sock.user` reported only the LID form, so the same
  // self-chat re-delivered under the phone JID after a resync did not match
  // "me" and every one of the user's own messages was dropped silently.
  const sessionDir = mkdtempSync(path.join(os.tmpdir(), 'hermes-wa-self-'));

  try {
    writeFileSync(path.join(sessionDir, 'lid-mapping-19175395595.json'), JSON.stringify('267383306489914'));
    writeFileSync(path.join(sessionDir, 'lid-mapping-267383306489914_reverse.json'), JSON.stringify('19175395595'));

    const selfIds = collectSelfIdentifiers(['267383306489914:7@lid'], sessionDir);

    assert.equal(matchesSelfIdentifier(selfIds, '267383306489914@lid'), true);
    assert.equal(matchesSelfIdentifier(selfIds, '19175395595@s.whatsapp.net'), true);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('collectSelfIdentifiers keeps both forms when the socket reports both', () => {
  const sessionDir = mkdtempSync(path.join(os.tmpdir(), 'hermes-wa-self-'));

  try {
    const selfIds = collectSelfIdentifiers(
      ['19175395595:12@s.whatsapp.net', '267383306489914:12@lid', undefined, ''],
      sessionDir,
    );

    assert.deepEqual([...selfIds].sort(), ['19175395595', '267383306489914']);
    // A stranger must still fail, with or without a mapping file present.
    assert.equal(matchesSelfIdentifier(selfIds, '188012763865257@lid'), false);
    assert.equal(matchesSelfIdentifier(selfIds, '19998887777@s.whatsapp.net'), false);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('matchesSelfIdentifier scans every candidate JID and fails closed', () => {
  const selfIds = collectSelfIdentifiers(['19175395595@s.whatsapp.net'], os.tmpdir());

  // `remoteJidAlt` / `participantAlt` are the alternate-addressing twins the
  // caller passes alongside the primary JID — a hit on any of them is a hit.
  assert.equal(matchesSelfIdentifier(selfIds, '267383306489914@lid', '19175395595@s.whatsapp.net'), true);
  assert.equal(matchesSelfIdentifier(selfIds, '267383306489914@lid', undefined), false);

  // No known identity yet (unpaired socket) must never read as "self".
  assert.equal(matchesSelfIdentifier(new Set(), '19175395595@s.whatsapp.net'), false);
  assert.equal(matchesSelfIdentifier(null, '19175395595@s.whatsapp.net'), false);
});

test('matchesAllowedUser treats * as allow-all wildcard', () => {
  const sessionDir = mkdtempSync(path.join(os.tmpdir(), 'hermes-wa-allowlist-'));

  try {
    const allowedUsers = parseAllowedUsers('*');
    assert.equal(matchesAllowedUser('19175395595@s.whatsapp.net', allowedUsers, sessionDir), true);
    assert.equal(matchesAllowedUser('267383306489914@lid', allowedUsers, sessionDir), true);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('matchesAllowedUser rejects everyone when allowlist is empty (#8389)', () => {
  // Regression guard: empty allowlist used to return true (allow-everyone),
  // which let any stranger DM the bridge and trigger a Python-side
  // pairing-code reply. Secure default is now "reject unless explicitly
  // configured"; operators who want an open bot must set `*`.
  const sessionDir = mkdtempSync(path.join(os.tmpdir(), 'hermes-wa-allowlist-'));

  try {
    const empty = parseAllowedUsers('');
    assert.equal(empty.size, 0);
    assert.equal(matchesAllowedUser('19175395595@s.whatsapp.net', empty, sessionDir), false);
    assert.equal(matchesAllowedUser('267383306489914@lid', empty, sessionDir), false);

    // Null/undefined allowlist (defensive) also rejects.
    assert.equal(matchesAllowedUser('19175395595@s.whatsapp.net', null, sessionDir), false);
    assert.equal(matchesAllowedUser('19175395595@s.whatsapp.net', undefined, sessionDir), false);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});
