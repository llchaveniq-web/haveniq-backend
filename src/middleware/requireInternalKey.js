/**
 * The single guard for internal / server-to-server endpoints.
 *
 * These are the routes no end-user should ever call: cron triggers, the
 * signup auto-review bot, match recompute, the weight analyst, data refresh.
 * They are NOT user-authenticated — there is no JWT — so the secret header IS
 * the authentication.
 *
 * WHY THIS FILE EXISTS: the check used to be copy-pasted into five route files
 * (botAdmin, housing, matchOutcomes, profile, weightLearning). Four of those
 * copies compared with `got !== tok` — a plain string compare, which leaks
 * match length through response timing. Only one did it in constant time. A
 * duplicated security check drifts, and the drift is invisible until someone
 * audits all five. One implementation, one place, no copies.
 *
 * ACCEPTS EITHER:
 *   • X-Internal-Key: <INTERNAL_API_KEY>            ← preferred going forward
 *   • Authorization: Bearer <ADMIN_BOT_TOKEN>       ← the existing bot callers
 * Both are constant-time compared. The legacy form is still accepted because
 * live cron jobs and the Discord bot authenticate that way today; dropping it
 * in the same change would take those down silently.
 *
 * NEVER put either secret in a client build, an API response, or a log line.
 * They live only in the server env and in the caller's own config.
 */

const crypto = require('crypto');

/**
 * Constant-time string equality. A length mismatch short-circuits — that only
 * reveals the length, which is fixed for our tokens — otherwise timingSafeEqual
 * so a wrong key can't be discovered byte-by-byte from response timing.
 */
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** The secrets this process will accept, in preference order. */
function configuredSecrets() {
  return [
    { header: 'x-internal-key', value: process.env.INTERNAL_API_KEY },
    { header: 'authorization',  value: process.env.ADMIN_BOT_TOKEN, bearer: true },
  ].filter((s) => typeof s.value === 'string' && s.value.length > 0);
}

/**
 * Express middleware. 401 on missing/wrong key; 503 when NO secret is
 * configured at all — fail closed, so a deploy that loses the env var locks
 * these endpoints rather than exposing them.
 */
function requireInternalKey(req, res, next) {
  const secrets = configuredSecrets();
  if (secrets.length === 0) {
    return res.status(503).json({ error: 'Internal endpoints disabled (no server key configured).' });
  }

  for (const s of secrets) {
    const raw = req.headers[s.header];
    if (!raw) continue;
    const presented = s.bearer
      ? (String(raw).startsWith('Bearer ') ? String(raw).slice(7) : '')
      : String(raw);
    // Compare against EVERY configured secret rather than returning early on
    // the first header present, so sending an X-Internal-Key does not stop the
    // legacy bearer token from being accepted (and vice versa).
    if (constantTimeEqual(presented, s.value)) return next();
  }

  return res.status(401).json({ error: 'Invalid internal key.' });
}

/**
 * Does this request carry a valid internal key? Used by the global rate
 * limiter to exempt authenticated internal callers without duplicating the
 * comparison logic.
 */
function hasValidInternalKey(req) {
  for (const s of configuredSecrets()) {
    const raw = req.headers?.[s.header] ?? (req.get ? req.get(s.header) : null);
    if (!raw) continue;
    const presented = s.bearer
      ? (String(raw).startsWith('Bearer ') ? String(raw).slice(7) : '')
      : String(raw);
    if (constantTimeEqual(presented, s.value)) return true;
  }
  return false;
}

module.exports = { requireInternalKey, hasValidInternalKey, constantTimeEqual };
