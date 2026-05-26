// ─── Suspicious activity logger ──────────────────────────────────────────
//
// Lightweight in-memory anomaly detector. Sits in front of routes that a
// scraper would want to abuse (profile lookups, the matches feed, message
// threads) and counts how often each user is hitting them inside a sliding
// window. When a user exceeds a per-route threshold, we audit-log the
// event so it's visible in the admin tools, fire a PostHog event so
// alerts can trigger off it, and tag req.suspicious so the route can
// react if it wants (we don't BLOCK by default — false positives at
// 100-user scale would be worse than a slow scraper).
//
// Important properties:
//   • In-memory (Map), per backend instance. With 1 Railway replica that's
//     fine. When we go multi-instance, swap for Redis without changing
//     the call sites — only this file needs to change.
//   • Self-cleaning: every check, expired window entries are deleted. No
//     unbounded growth even under sustained traffic.
//   • Fire-and-forget audit + analytics. Never blocks the request.
//   • Tunable per-route via the factory function.
//
// Threat model: a logged-in user (or compromised account) systematically
// pulling other users' profile data, scraping match results, or harvesting
// message contents. Rate limiting on auth blocks signup floods; this is
// what catches scraping AFTER signup.

const { audit } = require('../services/auditLog');
const analytics = require('../services/analytics');

// activity[userId][action] = { count, windowStartedAt }
const activity = new Map();

// Clean up entries older than 10 minutes every 60s so the Map can't grow
// unbounded if a backend instance runs for weeks without restart.
const CLEANUP_INTERVAL_MS = 60_000;
const ENTRY_TTL_MS        = 10 * 60 * 1000;

let cleanupHandle = null;
function startCleanupLoop() {
  if (cleanupHandle) return;
  cleanupHandle = setInterval(() => {
    const now = Date.now();
    for (const [userId, perAction] of activity.entries()) {
      for (const [action, entry] of Object.entries(perAction)) {
        if (now - entry.windowStartedAt > ENTRY_TTL_MS) delete perAction[action];
      }
      if (Object.keys(perAction).length === 0) activity.delete(userId);
    }
  }, CLEANUP_INTERVAL_MS);
  // Don't keep the event loop alive just for this — process exit shouldn't
  // wait for the cleanup loop.
  if (cleanupHandle.unref) cleanupHandle.unref();
}

/**
 * Factory that returns Express middleware for one route + threshold.
 *
 * @param {string} action      Short label, e.g. "profile.lookup", "matches.feed".
 *                             Shows up in audit_log.action when the threshold
 *                             trips, so keep it grep-able.
 * @param {number} threshold   Max requests this user can make to this action
 *                             inside the window before we flag suspicious.
 * @param {number} windowMs    Sliding window length in ms. Defaults to 5 min.
 * @returns Express middleware
 */
function track(action, threshold, windowMs = 5 * 60 * 1000) {
  startCleanupLoop();
  return function trackMiddleware(req, res, next) {
    // Only meaningful for authenticated requests. Anonymous traffic is
    // already covered by the IP-based rate limiters on auth routes.
    const userId = req.user?.id;
    if (!userId) return next();

    const now = Date.now();
    let perAction = activity.get(userId);
    if (!perAction) {
      perAction = {};
      activity.set(userId, perAction);
    }

    const entry = perAction[action];
    if (!entry || now - entry.windowStartedAt > windowMs) {
      perAction[action] = { count: 1, windowStartedAt: now, flagged: false };
      return next();
    }

    entry.count += 1;

    if (entry.count > threshold && !entry.flagged) {
      // Mark so we don't audit-log every subsequent request in the same
      // window. The single "user crossed the threshold" event is enough
      // signal — duplicate logs just spam the audit table.
      entry.flagged = true;
      req.suspicious = true;

      const details = {
        action,
        count_in_window: entry.count,
        threshold,
        window_ms: windowMs,
        path: req.originalUrl?.slice(0, 200),
      };

      // Fire-and-forget audit. Mirrors the auditLog pattern used elsewhere.
      audit(req, `suspicious.${action}`, details).catch(() => {});

      // PostHog event so you can wire an alert: "if suspicious.* count > 0
      // in last hour, email me". Free tier supports this.
      try {
        analytics.track(
          analytics.EVENTS.suspicious_activity ?? 'suspicious_activity',
          userId,
          details,
        );
      } catch { /* analytics is best-effort */ }

      // Also surface in stderr so it shows up in Railway logs immediately,
      // before the user gets around to checking the audit table.
      console.warn(
        `[suspicious] user=${userId} action=${action} count=${entry.count} threshold=${threshold} path=${details.path}`,
      );
    }

    next();
  };
}

// For tests + admin tooling — expose a way to peek and to clear.
function _peek(userId) { return activity.get(userId); }
function _clear()      { activity.clear(); }

module.exports = { track, _peek, _clear };
