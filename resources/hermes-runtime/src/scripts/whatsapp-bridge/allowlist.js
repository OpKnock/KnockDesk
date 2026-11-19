import path from 'path';
import { existsSync, readFileSync } from 'fs';

export function normalizeWhatsAppIdentifier(value) {
  return String(value || '')
    .trim()
    .replace(/:.*@/, '@')
    .replace(/@.*/, '')
    .replace(/^\+/, '');
}

export function parseAllowedUsers(rawValue) {
  return new Set(
    String(rawValue || '')
      .split(',')
      .map((value) => normalizeWhatsAppIdentifier(value))
      .filter(Boolean)
  );
}

function readMappingFile(sessionDir, identifier, suffix = '') {
  const filePath = path.join(sessionDir, `lid-mapping-${identifier}${suffix}.json`);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const normalized = normalizeWhatsAppIdentifier(parsed);
    return normalized || null;
  } catch {
    return null;
  }
}

export function expandWhatsAppIdentifiers(identifier, sessionDir) {
  const normalized = normalizeWhatsAppIdentifier(identifier);
  if (!normalized) {
    return new Set();
  }

  // Walk both phone->LID and LID->phone mapping files so allowlists can use
  // either form transparently in bot mode.
  const resolved = new Set();
  const queue = [normalized];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || resolved.has(current)) {
      continue;
    }

    resolved.add(current);

    for (const suffix of ['', '_reverse']) {
      const mapped = readMappingFile(sessionDir, current, suffix);
      if (mapped && !resolved.has(mapped)) {
        queue.push(mapped);
      }
    }
  }

  return resolved;
}

/**
 * Every identifier that means "me", expanded from whatever seeds we can prove
 * are ours (live socket id/lid, saved creds) through the lid-mapping files.
 *
 * WhatsApp addresses one account by BOTH a phone JID and a LID, and it switches
 * between them without warning — the same self-chat arrives as
 * `92300...@s.whatsapp.net` after a resync and `2684...@lid` the rest of the
 * time. Anything comparing against a single form drops half the user's own
 * messages, so callers compare against this whole set instead.
 */
export function collectSelfIdentifiers(seeds, sessionDir) {
  const ids = new Set();
  for (const seed of seeds || []) {
    const id = normalizeWhatsAppIdentifier(seed);
    if (id) ids.add(id);
  }
  for (const id of [...ids]) {
    for (const alias of expandWhatsAppIdentifiers(id, sessionDir)) {
      ids.add(alias);
    }
  }
  return ids;
}

/** True when ANY of the given JIDs is one of our own identities. */
export function matchesSelfIdentifier(selfIds, ...jids) {
  if (!selfIds || selfIds.size === 0) {
    return false;
  }
  for (const jid of jids) {
    const id = normalizeWhatsAppIdentifier(jid);
    if (id && selfIds.has(id)) {
      return true;
    }
  }
  return false;
}

export function matchesAllowedUser(senderId, allowedUsers, sessionDir) {
  // Empty allowlist = NO ONE allowed (secure default, #8389).  Operators
  // who want an open bot must set ``WHATSAPP_ALLOWED_USERS=*`` explicitly.
  // Previous behaviour (empty → return true) let any stranger DM the
  // bridge and trigger a Python-side pairing-code reply.
  if (!allowedUsers || allowedUsers.size === 0) {
    return false;
  }

  // "*" means allow everyone (consistent with SIGNAL_GROUP_ALLOWED_USERS)
  if (allowedUsers.has('*')) {
    return true;
  }

  const aliases = expandWhatsAppIdentifiers(senderId, sessionDir);
  for (const alias of aliases) {
    if (allowedUsers.has(alias)) {
      return true;
    }
  }

  return false;
}
