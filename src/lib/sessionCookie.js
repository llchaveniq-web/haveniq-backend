// ═══════════════════════════════════════════════════════════════════════════
//  Session-cookie helper — the httpOnly-cookie auth migration (staged).
//
//  The web session token lives in localStorage today, which any JavaScript can
//  read (an XSS could exfiltrate it). This moves it into an httpOnly + Secure
//  cookie the browser will not expose to JS at all, so a stolen-token XSS is off
//  the table.
//
//  FLAG-GATED (COOKIE_AUTH_ENABLED, default off) and INERT until enabled, because
//  it is only SAFE once the API is on a SAME-SITE subdomain of the app
//  (api.haveniq.org ↔ haveniq.org). A cookie set from the current cross-site
//  Railway domain would be a THIRD-PARTY cookie — blocked by Safari ITP and
//  Chrome's phase-out — and would break login. So: stand up api.haveniq.org,
//  set COOKIE_DOMAIN=.haveniq.org, point the app at api.haveniq.org, THEN flip
//  the flag. Full runbook: docs/COOKIE_AUTH_MIGRATION.md.
//
//  The READ side (readTokenCookie) is always active and harmless pre-migration:
//  no cookie is ever set until the flag is on, so it simply returns null.
// ═══════════════════════════════════════════════════════════════════════════

const COOKIE_NAME  = 'hq_session';
const MAX_AGE_MS   = 7 * 24 * 60 * 60 * 1000;   // mirrors the JWT 7-day TTL

const cookieAuthEnabled = () => process.env.COOKIE_AUTH_ENABLED === 'true';

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

// Set the session cookie alongside the JSON token response. No-op unless the
// flag is on, so wiring this into every token-issuing route is safe to deploy
// long before the migration is switched on.
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
