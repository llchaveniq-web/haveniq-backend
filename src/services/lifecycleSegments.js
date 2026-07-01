// ═══════════════════════════════════════════════════════════════════════════
//  Lifecycle segmentation — REAL DB state only, never an invented segment or
//  count. Each segment is a SQL predicate over facts the database actually
//  holds; the matching frozen template's claim is true for every recipient.
//
//  Every segment shares the eligibility gate: verified, not banned, a real
//  (non-demo) email that hasn't hard-bounced or filed a spam complaint
//  (email_undeliverable = opted-out), and no lifecycle email in the cooldown
//  window (the frequency cap, enforced in SQL so a re-run cannot double-send).
//
//  The pure helpers (circuitBreaker, dedupByPriority) are unit-tested without a
//  database.
// ═══════════════════════════════════════════════════════════════════════════

const { notDemo } = require('../lib/demoFilter');

// Shared eligibility + consent gate. `u` is the users alias.
const ELIGIBLE = `
      u.is_verified = TRUE
  AND COALESCE(u.is_banned, FALSE) = FALSE
  AND COALESCE(u.email_undeliverable, FALSE) = FALSE   -- bounce / spam complaint = opted-out
  AND u.email IS NOT NULL AND u.email <> ''
  AND (${notDemo('u.email')})
`;

// Frequency cap: exclude anyone who got ANY lifecycle send inside the cooldown.
// $1 = cooldown days. Enforced here so the guarantee holds even on a re-run.
const NOT_RECENTLY_SENT = `
  AND NOT EXISTS (
    SELECT 1 FROM lifecycle_sends ls
     WHERE ls.user_id = u.id AND ls.status = 'sent'
       AND ls.sent_at > NOW() - make_interval(days => $1)
  )
`;

// Segments in PRIORITY order — a user who matches more than one gets only the
// highest-priority nudge (dedupByPriority), i.e. their most useful next action.
const SEGMENTS = [
  {
    id: 'quiz_incomplete',
    templateId: 'quiz_incomplete_v1',
    // Signed up (settled >1 day so the welcome email leads) but no completed quiz.
    sql: `
      SELECT u.id, u.email, u.first_name
        FROM users u
       WHERE ${ELIGIBLE}
         AND u.created_at < NOW() - INTERVAL '1 day'
         AND NOT EXISTS (SELECT 1 FROM quiz_answers qa WHERE qa.user_id = u.id AND qa.completed = TRUE)
         ${NOT_RECENTLY_SENT}
       LIMIT 5000`,
  },
  {
    id: 'matches_waiting',
    templateId: 'matches_waiting_v1',
    // Quiz done, HAS >=1 computed match, and has reached out to NOBODY. ("No
    // matches viewed" is not a DB fact, so we use this real, queryable proxy —
    // and requiring a real match makes "your matches are ready" honest.)
    sql: `
      SELECT u.id, u.email, u.first_name
        FROM users u
       WHERE ${ELIGIBLE}
         AND EXISTS (SELECT 1 FROM quiz_answers qa WHERE qa.user_id = u.id AND qa.completed = TRUE)
         AND EXISTS (SELECT 1 FROM compatibility_scores cs WHERE cs.user_a = u.id OR cs.user_b = u.id)
         AND NOT EXISTS (SELECT 1 FROM connect_requests cr WHERE cr.from_user = u.id)
         ${NOT_RECENTLY_SENT}
       LIMIT 5000`,
  },
  {
    id: 'invited_nobody',
    templateId: 'invited_nobody_v1',
    // Engaged (quiz done) but zero successful referrals. referrals.referrer_id
    // is TEXT; users.id is UUID → cast.
    sql: `
      SELECT u.id, u.email, u.first_name
        FROM users u
       WHERE ${ELIGIBLE}
         AND EXISTS (SELECT 1 FROM quiz_answers qa WHERE qa.user_id = u.id AND qa.completed = TRUE)
         AND NOT EXISTS (SELECT 1 FROM referrals r WHERE r.referrer_id = u.id::text)
         ${NOT_RECENTLY_SENT}
       LIMIT 5000`,
  },
];

// Denominator for the circuit breaker: eligible users who are actually ACTIVE
// (seen, or created, within the active window). $1 = active-window days.
const ACTIVE_USERS_SQL = `
  SELECT COUNT(*)::int AS n
    FROM users u
   WHERE ${ELIGIBLE}
     AND ( u.last_active_at >= NOW() - make_interval(days => $1)
        OR (u.last_active_at IS NULL AND u.created_at >= NOW() - make_interval(days => $1)) )
`;

// ── Pure guardrail helpers ─────────────────────────────────────────────────

// One nudge per user: keep the first (highest-priority) segment a user appears
// in. `bySegment` is [{ segmentId, templateId, recipients:[{id,email,first_name}] }]
// already in priority order. Returns a flat [{ userId, email, firstName,
// segmentId, templateId }] with each user at most once.
function dedupByPriority(bySegment) {
  const seen = new Set();
  const out = [];
  for (const seg of bySegment) {
    for (const r of seg.recipients || []) {
      if (!r || !r.id || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ userId: r.id, email: r.email, firstName: r.first_name, segmentId: seg.segmentId, templateId: seg.templateId });
    }
  }
  return out;
}

// Volume circuit breaker. A run may send to at most `threshold` recipients:
//   threshold = max(minAbs, floor(activeCount * maxFraction))
// If the planned count exceeds it, the run is a suspected segmentation blast →
// TRIP (pause + page, never send). minAbs is a small absolute allowance so a
// legitimately tiny launch batch doesn't trip on the fraction alone; set it to
// 0 to enforce a pure fraction.
function circuitBreaker(plannedCount, activeCount, maxFraction, minAbs) {
  const frac = Number.isFinite(maxFraction) ? maxFraction : 0.1;
  const floorAbs = Number.isFinite(minAbs) ? minAbs : 0;
  const threshold = Math.max(floorAbs, Math.floor((activeCount || 0) * frac));
  return { trip: plannedCount > threshold, threshold, plannedCount, activeCount: activeCount || 0, maxFraction: frac };
}

module.exports = { SEGMENTS, ACTIVE_USERS_SQL, ELIGIBLE, dedupByPriority, circuitBreaker };
