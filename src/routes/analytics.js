const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { quickAction } = require('../middleware/rateLimits');
const analytics = require('../services/analytics');

// ─── POST /analytics/events ────────────────────────────────────────────
// The frontend's services/api.ts AnalyticsAPI.trackEvent() has called this
// path since it was written, mirroring named funnel events (match_blocked,
// safety_rate_limit_hit, checkin_answered, premium_upgraded, ...) to
// PostHog server-side — but this route never existed, so every one of
// those calls has been a silent 404 (trackEvent is fire-and-forget: it
// never surfaced as a user-visible error). This is the missing route.
//
// Distinct from POST /telemetry/batch: that's the high-volume behavioral/
// biometric event stream with a closed ALLOWED_TYPES enum and its own DB
// table. This is a thin pass-through to the same named-event PostHog
// helper (services/analytics.js) that server-side code already calls
// directly — the client just doesn't have a way to reach it.
router.post('/events', requireAuth, quickAction, async (req, res) => {
  const { event, properties } = req.body || {};

  if (typeof event !== 'string' || event.length === 0 || event.length > 100) {
    return res.status(400).json({ error: 'event (string, 1-100 chars) required' });
  }
  if (properties !== undefined && properties !== null &&
      (typeof properties !== 'object' || Array.isArray(properties))) {
    return res.status(400).json({ error: 'properties must be an object' });
  }

  // Bound payload size — this is fire-and-forget telemetry, not a place for
  // a client to smuggle an arbitrarily large blob into PostHog.
  const props = properties || {};
  if (JSON.stringify(props).length > 4000) {
    return res.status(400).json({ error: 'properties too large' });
  }

  analytics.track(event, req.user.id, props);
  res.json({ recorded: true });
});

module.exports = router;
