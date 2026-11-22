// Title bar ke gol nishan ke liye account ki pehchan: email, naam, tasveer.
//
// ── TASVEER KAHAN SE AATI HAI ───────────────────────────────────────────────
//
// Google se login par Supabase user ki tasveer ka link `user_metadata` mein
// rakhta hai (`avatar_url`, aur wohi `picture` mein bhi), aur Supabase ka har
// access token (JWT) apne andar ye `user_metadata` saath laata hai. Website ka
// AccountMenu bhi yehi do field parhta hai. Is liye:
//
//   - koi network call nahi — token disk par pehle se para hai,
//   - login ka flow nahi chhera,
//   - token refresh ho to naya link khud aa jata hai (user ne Google par
//     tasveer badli ho to bhi).
//
// Email/password wale login par tasveer hoti hi nahi — `avatarUrl: null`, aur
// screen par pehle ki tarah email ka pehla harf.
//
// ── RENDERER KO SIRF YE TEEN CHEEZEIN ───────────────────────────────────────
//
// Token main process se bahar nahi jata. Link sirf `https:` ho to aage jata
// hai, taake `javascript:` ya `file:` jaisa kuch kabhi <img> tak na pohnche.
//
// JWT ka signature yahan check NAHI hota, aur zaroorat bhi nahi: ye sirf
// dikhane ki cheez hai. Access ka faisla server karta hai (`access-check`).

const MAX_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 80;

/** JWT ka beech wala hissa (claims). Parha na jaye to null. */
function decodeClaims(jwt) {
  try {
    const payload = String(jwt || '').split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

function httpsUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return name || null;
}

/**
 * @param {{ email?: string, token?: string } | null} auth  auth store ka data
 * @returns {{ email: string, name: string | null, avatarUrl: string | null } | null}
 */
function profileFromAuth(auth) {
  const email = typeof auth?.email === 'string' ? auth.email.trim() : '';
  if (!email) return null;

  const claims = decodeClaims(auth.token);

  // Token kisi aur account ka nikle (aisa hona nahi chahiye, magar file ek
  // adhoore login ke beech bhi reh sakti hai) to us ki tasveer is email ke
  // saath nahi lagti — ghalat chehra dikhana khali harf se kahin bura hai.
  const sameAccount = !claims?.email
    || String(claims.email).trim().toLowerCase() === email.toLowerCase();
  const meta = sameAccount && claims?.user_metadata && typeof claims.user_metadata === 'object'
    ? claims.user_metadata
    : {};

  return {
    email,
    name: cleanName(meta.full_name) || cleanName(meta.name),
    avatarUrl: httpsUrl(meta.avatar_url) || httpsUrl(meta.picture),
  };
}

module.exports = { profileFromAuth };
