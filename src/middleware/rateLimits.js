// ─── Per-endpoint rate limiters for write actions ────────────────────────
//
// The global 200/15-min limit in server.js stops only the noisiest abuse.
// Write actions (post a review, submit a rule, nominate a roommate)
// deserve tighter caps:
//   - Per-IP to stop one network from flooding
//   - Per-user (when authenticated) to stop one account from flooding
//     across rotating IPs (VPNs, mobile networks)
//
// Each limiter is keyed by `user_id || ip` so authenticated users get a
// real per-user limit and anonymous traffic still gets the IP fallback.
// The ipKeyGenerator helper handles IPv6 collapsing so a single attacker
// can't rotate through trillions of /128 addresses.
//
// Numbers are tuned for normal student behavior: ~1-2 reviews/week,
// ~5-10 house rules during onboarding, ~5 nominations/semester. Anything
// dramatically above that pattern is almost certainly broken UX or abuse.

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

function userOrIpKey(req) {
  // req.user is set by requireAuth before these limiters run.
  if (req.user?.id) return `u:${req.user.id}`;
  return `ip:${ipKeyGenerator(req)}`;
}

/** Reviews — landlord + building. 10/hour per user is generous. */
const writeReview = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many reviews submitted. Take a breath and try again in an hour.' },
  keyGenerator: userOrIpKey,
  standardHeaders: true,
  legacyHeaders: false,
});

/** House rules — onboarding burst is real; 20/hour covers it. */
const submitRule = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many rules in a short time. Try again in an hour.' },
  keyGenerator: userOrIpKey,
  standardHeaders: true,
  legacyHeaders: false,
});

/** Best Roommate nominations — 5/day per user. */
const submitNomination = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  message: { error: 'Limit of 5 nominations per day reached. Try again tomorrow.' },
  keyGenerator: userOrIpKey,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Quick-action limiter for thumbs-up, votes, and other low-cost writes
 * that legitimately happen in bursts (a user thumbing 10 rules quickly).
 * 60/hour is plenty without being abusable.
 */
const quickAction = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  message: { error: 'Too many quick actions. Slow down for a moment.' },
  keyGenerator: userOrIpKey,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Safety reports — tightest limiter. Abuse pattern: someone mass-reports
 * an account they don't like to harass them off the platform. 5/day is
 * enough for legitimate reporting (you're rarely going to legitimately
 * file 5 reports on different users in one day).
 */
const safetyReport = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  message: { error: 'Report limit reached for today. Email support@haveniq.org if it\'s urgent.' },
  keyGenerator: userOrIpKey,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Blocks — more generous than reports. A user might block several
 * people in a row when cleaning up their feed; 30/day is plenty.
 */
const safetyBlock = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 30,
  message: { error: 'Block limit reached. Try again tomorrow.' },
  keyGenerator: userOrIpKey,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { writeReview, submitRule, submitNomination, quickAction, safetyReport, safetyBlock };
