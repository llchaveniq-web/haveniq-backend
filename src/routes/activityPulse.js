/**
 * Activity Pulse — the rotating "what's happening on HavenIQ" banner.
 *
 * Returns 3-5 short messages tailored to the user, rotating through:
 *   • New students from their school (this week)
 *   • Matches updated their answers recently
 *   • Compatibility recalc happening overnight
 *   • New matches added since last visit
 *   • Quiz answer milestones nationally
 *
 * Each message is grounded in real database state — no fake numbers.
 * If we don't have enough signal for a category, we omit it. Empty
 * payload is OK; the frontend just hides the banner.
 *
 * Cached server-side per-user for 10 minutes to avoid hammering the
 * DB on every Home tab visit.
 */

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // userId → { until, messages }

router.get('/activity-pulse', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const now = Date.now();

  // Cache check
  const cached = cache.get(userId);
  if (cached && cached.until > now) {
    return res.json({ messages: cached.messages, cached: true });
  }

  const messages = [];

  // 1. New students from same school this week
  try {
    const { rows } = await pool.query(
      `SELECT school FROM users WHERE id = $1`, [userId],
    );
    const school = rows[0]?.school;
    if (school) {
      const { rows: count } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM users
          WHERE school = $1
            AND id != $2
            AND created_at > NOW() - INTERVAL '7 days'
            AND COALESCE(is_paused, FALSE) = FALSE
            AND COALESCE(is_banned, FALSE) = FALSE
            AND email NOT LIKE '%@haveniq-demo.edu'`,
        [school, userId],
      );
      const n = count[0]?.n ?? 0;
      if (n > 0) {
        messages.push({
          icon: '✦',
          text: n === 1
            ? `1 new student from ${school} joined this week.`
            : `${n} new students from ${school} joined this week.`,
        });
      }
    }
  } catch (e) { /* silent — banner is best-effort */ }

  // 2. Top matches updated answers recently
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT u.id)::int AS n FROM compatibility_scores cs
       JOIN users u ON (CASE WHEN cs.user_a = $1 THEN cs.user_b ELSE cs.user_a END = u.id)
       WHERE (cs.user_a = $1 OR cs.user_b = $1)
         AND cs.score >= 80
         AND u.updated_at > NOW() - INTERVAL '7 days'
         AND COALESCE(u.is_paused, FALSE) = FALSE
         AND COALESCE(u.is_banned, FALSE) = FALSE`,
      [userId],
    );
    const n = rows[0]?.n ?? 0;
    if (n > 0) {
      messages.push({
        icon: '⟳',
        text: n === 1
          ? `1 of your top matches updated their answers this week — scores refreshing.`
          : `${n} of your top matches updated their answers this week — scores refreshing.`,
      });
    }
  } catch (e) { /* silent */ }

  // 3. New matches added to user's pool in last 24h
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM compatibility_scores cs
       WHERE (cs.user_a = $1 OR cs.user_b = $1)
         AND cs.is_hard_blocked = FALSE
         AND cs.score >= 70
         AND cs.calculated_at > NOW() - INTERVAL '24 hours'`,
      [userId],
    );
    const n = rows[0]?.n ?? 0;
    if (n > 0) {
      messages.push({
        icon: '◇',
        text: n === 1
          ? `1 new match was added to your pool overnight.`
          : `${n} new matches were added to your pool overnight.`,
      });
    }
  } catch (e) { /* silent */ }

  // 4. Always-true gentle message — daily recalc reminder.
  // Only show if we have FEWER than 2 other messages, otherwise the
  // banner gets noisy.
  if (messages.length < 2) {
    messages.push({
      icon: '☾',
      text: 'Compatibility scores recalculate overnight. Fresh matches arrive at 9 AM.',
    });
  }

  // Cap at 4 messages so the rotation isn't endless
  const capped = messages.slice(0, 4);

  cache.set(userId, { until: now + CACHE_MS, messages: capped });
  res.json({ messages: capped, cached: false });
});

module.exports = router;
