/**
 * Feature usage — powers the home "Popular with students" strip with REAL
 * aggregate data (not seeded, not fabricated).
 *
 *   POST /feature-usage { route }   (auth) → record that this user opened a feature
 *   GET  /feature-usage/popular     (auth) → features OTHER students actually use
 *
 * We count DISTINCT users per route (so one power-user can't skew it), and the
 * /popular query deliberately EXCLUDES the requesting user and requires at
 * least 2 other students — so it's honestly "what other students go on," and
 * stays empty (the strip hides itself) until a campus has real usage. No
 * fake popularity. Self-migrating table; failures never touch other flows.
 */
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

let ready = false;
async function ensureTables() {
  if (ready) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feature_usage (
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      route      TEXT NOT NULL,
      count      BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, route)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_feature_usage_route ON feature_usage (route)`);
  ready = true;
}

// Catalog routes look like '/chore-wheel', '/move-out-checklist', etc.
const ROUTE_RE = /^\/[a-zA-Z0-9\-_/]{1,79}$/;
const MIN_OTHER_STUDENTS = 2; // a route is "popular" only once ≥2 OTHER students use it

// POST /feature-usage { route } — increment this user's open count for a route.
router.post('/', requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const route = typeof req.body?.route === 'string' ? req.body.route.trim() : '';
    if (!ROUTE_RE.test(route)) return res.status(400).json({ error: 'bad route' });
    await pool.query(
      `INSERT INTO feature_usage (user_id, route, count, updated_at)
         VALUES ($1, $2, 1, now())
       ON CONFLICT (user_id, route)
         DO UPDATE SET count = feature_usage.count + 1, updated_at = now()`,
      [String(req.user.id), route]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[feature-usage/log]', e.message);
    res.status(500).json({ error: 'failed' });
  }
});

// GET /feature-usage/popular — features OTHER students use, by distinct-user count.
router.get('/popular', requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const { rows } = await pool.query(
      `SELECT route, COUNT(DISTINCT user_id)::int AS users
         FROM feature_usage
        WHERE user_id <> $1
        GROUP BY route
       HAVING COUNT(DISTINCT user_id) >= $2
        ORDER BY users DESC, MAX(updated_at) DESC
        LIMIT 8`,
      [String(req.user.id), MIN_OTHER_STUDENTS]);
    res.json({ popular: rows });
  } catch (e) {
    console.error('[feature-usage/popular]', e.message);
    res.status(500).json({ error: 'failed' });
  }
});

module.exports = router;
