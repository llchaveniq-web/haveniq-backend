const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

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
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

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
      'SELECT id, email, school, first_name, last_name, is_verified, is_paused, quiz_completed, is_premium, trust_score, is_banned, ban_reason FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (!rows[0]) {
      return res.status(401).json({ error: 'Account not found' });
    }

    req.user = rows[0];

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

module.exports = { requireAuth, refuseBanned, signToken };
