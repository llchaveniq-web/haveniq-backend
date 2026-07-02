// ═══════════════════════════════════════════════════════════════════════════
//  Signed unsubscribe tokens — the token IS the auth (no login to unsubscribe).
//
//  Format:  base64url(payload) "." base64url(HMAC-SHA256(payload))
//  Payload: { uid, p: purpose, exp: unix-seconds }
//
//  HMAC-signed with an EXISTING secret (UNSUB_SECRET, else the app JWT_SECRET),
//  so a token can't be forged and can't be replayed for a different purpose.
//  Purpose scoping ('lifecycle') keeps this away from any other token flow, and
//  it only ever unsubscribes from LIFECYCLE/marketing mail — never transactional
//  (login codes) email, which is sent through a separate path that doesn't
//  consult this at all.
// ═══════════════════════════════════════════════════════════════════════════
const crypto = require('crypto');

const secret = () => process.env.UNSUB_SECRET || process.env.JWT_SECRET || '';
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (body) => b64url(crypto.createHmac('sha256', secret()).update(body).digest());

// Sign a token for a user + purpose. ttlDays defaults to ~2 years so unsubscribe
// links in old emails keep working; pass a negative ttl in tests for "expired".
function sign(userId, purpose = 'lifecycle', ttlDays = 730) {
  const payload = { uid: String(userId), p: purpose, exp: Math.floor(Date.now() / 1000) + Math.round(ttlDays * 86400) };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${hmac(body)}`;
}

// Verify a token against the expected purpose. Returns { userId, purpose, exp }
// on success, or null on ANY problem (bad shape, bad signature, wrong purpose,
// expired). Constant-time signature compare; never throws.
function verify(token, expectedPurpose = 'lifecycle') {
  try {
    if (typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = hmac(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || !payload.uid || payload.p !== expectedPurpose) return null;
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return { userId: payload.uid, purpose: payload.p, exp: payload.exp };
  } catch {
    return null;
  }
}

module.exports = { sign, verify };
