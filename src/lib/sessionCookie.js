// ═══════════════════════════════════════════════════════════════════════════
//  Session-cookie helper — the httpOnly-cookie auth migration (staged).
//
//  The web session token lives in localStorage today, which any JavaScript can
//  read (an XSS could exfiltrate it). This moves it into an httpOnly + Secure
//  cookie the browser will not expose to JS at all, so a stolen-token XSS is off
//  the table.
//
//  ACTIVE BY DEFAULT. The precondition is now met: the API lives on
//  api.haveniq.org, a SAME-SITE subdomain of the app (shared registrable domain
//  haveniq.org), so hq_session is a first-party cookie (SameSite=Lax works; no
//  third-party-cookie blocking). This ships ADDITIVELY — the body token is still
//  returned and bearer is still accepted, so nothing changes for native/bearer
//  clients until the WEB client opts in (EXPO_PUBLIC_COOKIE_AUTH). A browser
//  that isn't in cookie mode never sends credentials, so the Set-Cookie it
//  receives is simply never used. Full runbook: docs/COOKIE_AUTH_MIGRATION.md.
//
//  Kill-switch: set COOKIE_AUTH_ENABLED=false to disable cookie-setting and the
//  CSRF guard server-side (emergency backend revert). Default (unset) = ON.
//  The READ side (readTokenCookie) is always active.
// ═══════════════════════════════════════════════════════════════════════════

const COOKIE_NAME  = 'hq_session';
const MAX_AGE_MS   = 7 * 24 * 60 * 60 * 1000;   // mirrors the JWT 7-day TTL

// ON unless explicitly disabled. Inverted from the original opt-in default now
// that the same-site-API precondition holds — see the header note.
const cookieAuthEnabled = () => process.env.COOKIE_AUTH_ENABLED !== 'false';

// Parse the session token out of the raw Cookie header. No cookie-parser dep —
// this is the only cookie we ever read. Returns null when absent/blank.
function readTokenCookie(req) {
  const raw = req && req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) {
      const val = part.slice(eq + 1).trim();
      if (!val) return null;
      try { return decodeURIComponent(val); } catch { return val; }
    }
  }
  return null;
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure:   true,                                    // HTTPS only (HSTS is on)
    sameSite: 'lax',                                   // first-party api↔app subdomains → Lax suffices + is CSRF-safe
    domain:   process.env.COOKIE_DOMAIN || undefined,  // '.haveniq.org' shares the cookie across app + api subdomains
    path:     '/',
  };
}

// Set the session cookie alongside the JSON token response. Active by default;
// no-op only if COOKIE_AUTH_ENABLED=false (kill-switch). Harmless for bearer
// clients — they don't send credentials, so they never return this cookie.
function setSessionCookie(res, token) {
  if (!cookieAuthEnabled()) return;
  res.cookie(COOKIE_NAME, token, { ...cookieOptions(), maxAge: MAX_AGE_MS });
}

// Server-side logout — an httpOnly cookie can't be cleared by client JS, so the
// logout route must do it. Always safe to call (clearing an absent cookie is a
// no-op for the browser).
function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, cookieOptions());
}

module.exports = { COOKIE_NAME, cookieAuthEnabled, readTokenCookie, setSessionCookie, clearSessionCookie };
