const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { readTokenCookie, cookieAuthEnabled } = require('../lib/sessionCookie');

// Session token from the Authorization header (native app + legacy web) OR,
// once the cookie migration is live, the httpOnly `hq_session` cookie. The
// header ALWAYS wins, so nothing changes for existing bearer clients; the
// cookie is a pure fallback that is null until COOKIE_AUTH_ENABLED is flipped.
function extractSessionToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.split(' ')[1];
  return readTokenCookie(req);
}

// Fail fast at module load if JWT_SECRET is missing or weak. A missing
// secret makes jwt.sign() throw on every signin; a short secret makes
// tokens trivially forgeable. Both are catastrophic and silent until
// the first user signs in — so refuse to boot the process.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  // eslint-disable-next-line no-console
  console.error(
    '[fatal] JWT_SECRET must be set and at least 32 characters. ' +
    'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
  );
  process.exit(1);
}

async function requireAuth(req, res, next) {
  try {
    const token = extractSessionToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Missing or invalid authorization' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    // Reject tokens with a `purpose` claim. The 2FA login flow issues a
    // short-lived JWT with `purpose: '2fa-challenge'` that must ONLY be
    // accepted by POST /auth/2fa/challenge. Without this guard, a leaked
    // challenge token (visible in browser network logs, error reports,
    // referer headers during the 5-minute window) could be sent as
    // `Authorization: Bearer <token>` and would authenticate as the
    // user — fully bypassing the 2FA prompt the challenge was supposed
    // to gate. Session tokens issued by signToken() carry only
    // `{ userId }` with no purpose, so they pass.
    if (decoded.purpose) {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    // Pull fresh user from DB on every request (catches banned/deleted accounts)
    const { rows } = await pool.query(
      'SELECT id, email, school, first_name, last_name, is_verified, is_paused, quiz_completed, is_premium, trust_score, is_banned, ban_reason, tokens_valid_after FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (!rows[0]) {
      return res.status(401).json({ error: 'Account not found' });
    }

    // Session revocation: reject any token issued BEFORE the user's cutoff (set
    // by POST /auth/logout-all). NULL cutoff ⇒ no check, so existing tokens are
    // never invalidated by the migration. iat is in seconds; cutoff in ms.
    if (sessionRevoked(decoded.iat, rows[0].tokens_valid_after)) {
      return res.status(401).json({ error: 'Session ended. Please sign in again.' });
    }

    req.user = rows[0];

    // Record real presence — powers the "Active today / Active Nd ago" label
    // on match cards. Fire-and-forget + throttled (only writes when the stored
    // value is older than 5 min), so it adds at most one write per user per
    // 5 min and never delays this request. Any authenticated request counts as
    // "active" — the most accurate signal we have.
    pool.query(
      `UPDATE users SET last_active_at = NOW()
       WHERE id = $1 AND (last_active_at IS NULL OR last_active_at < NOW() - INTERVAL '5 minutes')`,
      [decoded.userId],
    ).catch(() => { /* presence is best-effort — never break a request over it */ });

    // Pre-launch lock — refuse even a valid existing session if the account
    // isn't on the allowlist, so the app stays private to the founder
    // (+ invited helpers) until launch. Founder is always allowed; opens
    // for everyone when PRELAUNCH_LOCK=false. See lib/launchGate.js.
    {
      const { isAllowed, PRELAUNCH_MESSAGE } = require('../lib/launchGate');
      if (!isAllowed(req.user.email)) {
        return res.status(403).json({ error: PRELAUNCH_MESSAGE, prelaunch: true });
      }
    }

    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    next(err);
  }
}

/**
 * Optional auth — sets req.user when a valid session token is present, but
 * NEVER rejects when it's missing/invalid. For endpoints that serve both
 * signed-in and anonymous callers (e.g. the in-quiz preview, which runs
 * before signup in the anonymous quiz-first flow).
 */
async function optionalAuth(req, res, next) {
  try {
    const token = extractSessionToken(req);
    if (!token) return next();
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.purpose) return next();
    const { rows } = await pool.query(
      'SELECT id, email, school, first_name, last_name, is_verified, is_paused, quiz_completed, is_premium, trust_score, is_banned, ban_reason, tokens_valid_after FROM users WHERE id = $1',
      [decoded.userId],
    );
    if (rows[0]) req.user = rows[0];
  } catch {
    // Invalid/expired token → treat as anonymous, never error.
  }
  next();
}

/**
 * Stricter gate for write actions — refuses banned users with a clear
 * 403. Banned users can still call requireAuth (so they can see why
 * they were banned + reach support) but cannot send messages, connect
 * requests, reviews, etc. Stack after requireAuth on the routes that
 * matter:
 *   router.post('/...', requireAuth, refuseBanned, async (req, res) => ...)
 */
function refuseBanned(req, res, next) {
  if (req.user?.is_banned) {
    return res.status(403).json({
      error:     'Your account has been suspended. Contact support@haveniq.org if you believe this is in error.',
      banned:    true,
      banReason: req.user.ban_reason || null,
    });
  }
  next();
}

// CSRF guard for cookie-authenticated mutations. Inert unless COOKIE_AUTH_ENABLED.
// The session cookie is SameSite=Lax (so browsers don't send it on cross-site
// POSTs at all) — this is belt-and-suspenders: any state-changing request that
// rides the cookie must ALSO carry a custom header (X-HavenIQ-CSRF) that a
// cross-site page cannot set without a CORS preflight our origin allowlist
// denies. Requests with no session cookie (Stripe/identity webhooks, pre-login
// OTP, native bearer clients) are untouched — they carry no ambient credential
// to forge. Mount globally AFTER the body parser, before the routes.
function csrfGuard(req, res, next) {
  if (!cookieAuthEnabled()) return next();
  const m = req.method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
  if (!readTokenCookie(req)) return next();          // not cookie-authenticated → nothing to forge
  if (req.headers['x-haveniq-csrf']) return next();  // custom header ⇒ same-origin (CORS-preflighted)
  return res.status(403).json({ error: 'CSRF check failed' });
}

// Pure: was this token (JWT `iat`, seconds) issued BEFORE the user's revocation
// cutoff? Absent/NULL cutoff ⇒ never revoked, so the migration invalidates
// nothing. Extracted so the /auth/logout-all revocation is unit-testable.
function sessionRevoked(iat, tokensValidAfter) {
  if (!tokensValidAfter || !iat) return false;
  return iat * 1000 < new Date(tokensValidAfter).getTime();
}

function signToken(userId) {
  // 7-day TTL (was 30d). Combined with the /auth/refresh endpoint's
  // 7-day grace window, the maximum lifetime of a stolen JWT drops
  // from 30 days to 14 (one full TTL + one grace cycle). The frontend
  // refreshes on each app launch so users who open the app at least
  // weekly never see a forced sign-out; users who haven't logged in
  // in over two weeks get sent through the normal email-OTP flow.
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

module.exports = { requireAuth, optionalAuth, refuseBanned, signToken, csrfGuard, extractSessionToken, sessionRevoked };
