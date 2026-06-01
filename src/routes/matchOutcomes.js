/**
 * Match Outcomes — the data infrastructure that enables the matching
 * algorithm to learn.
 *
 * Today's matching is a hand-tuned weighted formula (services/scoring.js)
 * built from research-grounded weights. Until we have 50+ real pairs
 * who've been roommates (or decided not to be), those weights are an
 * educated hypothesis. This is the table that captures the ground truth.
 *
 * Two flavors of data captured here:
 *   1. Outcome events — meeting in person, moving in, ending the
 *      relationship, etc. Stored timestamp + outcome type + optional notes.
 *   2. Structured 60-day check-in surveys (when we build the in-app
 *      form). Maps directly to the scoring weights so we can later
 *      regress outcomes against weight contributions.
 *
 * Until we cross N=50, the data here is for founder-conducted interviews.
 * After that, it becomes the training signal for weight tuning.
 */

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const ALLOWED_OUTCOMES = new Set([
  'met_in_person',
  'decided_not_to_continue',
  'moved_in_together',
  'lease_signed',
  'still_chatting',
  'lost_contact',
  'ended_roommate_relationship',
  'survey_30d',           // 30-day satisfaction check-in (bot-driven outreach)
  'survey_60d',           // structured survey response — content lives in details
]);

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_outcomes (
      id              BIGSERIAL PRIMARY KEY,
      reporter_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      other_user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      outcome         TEXT NOT NULL,
      details         JSONB,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_match_outcomes_reporter
      ON match_outcomes(reporter_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_match_outcomes_pair
      ON match_outcomes(LEAST(reporter_id, other_user_id), GREATEST(reporter_id, other_user_id));
  `).catch((e) => console.error('[match_outcomes] ensure table:', e.message));
}

// ── POST /users/me/match-outcomes ──────────────────────────────────────
// User logs an event about a specific match. Most often used by the
// 60-day in-app survey (when we ship it) or by the founder hand-entering
// notes from a phone call.
router.post('/me/match-outcomes', requireAuth, async (req, res) => {
  await ensureTable();
  const { otherUserId, outcome, details } = req.body || {};
  if (!Number.isFinite(parseInt(otherUserId, 10))) return res.status(400).json({ error: 'otherUserId required' });
  if (!ALLOWED_OUTCOMES.has(outcome)) return res.status(400).json({ error: 'invalid outcome' });

  try {
    await pool.query(
      `INSERT INTO match_outcomes (reporter_id, other_user_id, outcome, details)
       VALUES ($1, $2, $3, $4)`,
      [req.user.id, parseInt(otherUserId, 10), outcome, details || null]
    );
    res.json({ recorded: true });
  } catch (err) {
    console.error('[match-outcomes] insert failed:', err);
    res.status(500).json({ error: 'failed to record outcome' });
  }
});

// ── GET /users/me/match-outcomes ───────────────────────────────────────
// User can view what THEY have logged. (Other party's responses are
// private — never cross-leaked.)
router.get('/me/match-outcomes', requireAuth, async (req, res) => {
  await ensureTable();
  try {
    const { rows } = await pool.query(
      `SELECT id, other_user_id, outcome, details, created_at
       FROM match_outcomes
       WHERE reporter_id = $1
       ORDER BY created_at DESC LIMIT 200`,
      [req.user.id]
    );
    res.json({ outcomes: rows });
  } catch (err) {
    console.error('[match-outcomes] read failed:', err);
    res.status(500).json({ error: 'failed to read outcomes' });
  }
});

// ── Bot-admin: pending 60-day check-ins ────────────────────────────────
// For the daily check-in cron. Returns matched pairs (both sides
// accepted a connect_request) whose FIRST mutual message exchange was
// ~60 days ago AND whom we haven't already checked in on. The bot
// pings the founder in Discord with each pair so the founder reaches
// out personally — phone calls beat surveys at low N.

const { requireBotToken } = (() => {
  try { return require('../middleware/botAuth'); }
  catch {
    return {
      requireBotToken: (req, res, next) => {
        const tok = process.env.ADMIN_BOT_TOKEN;
        if (!tok) return res.status(503).json({ error: 'bot auth disabled' });
        const auth = req.headers.authorization || '';
        const got = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        if (got !== tok) return res.status(401).json({ error: 'Invalid bot token.' });
        next();
      },
    };
  }
})();

router.get('/bot-admin/pending-checkins', requireBotToken, async (req, res) => {
  await ensureTable();
  try {
    // Pairs where:
    //   - earliest mutual message was 55-65 days ago (window so we don't miss any)
    //   - we have NOT already logged a survey_60d outcome on either side
    // Soft-fails if messages table doesn't exist yet — returns empty list.
    const { rows } = await pool.query(`
      WITH pair_first_msg AS (
        SELECT
          LEAST(sender_id, recipient_id)    AS user_a,
          GREATEST(sender_id, recipient_id) AS user_b,
          MIN(created_at)                   AS first_msg_at
        FROM messages
        GROUP BY 1, 2
      )
      SELECT
        pfm.user_a, pfm.user_b, pfm.first_msg_at,
        ua.first_name AS a_name, ua.email AS a_email, ua.school AS a_school,
        ub.first_name AS b_name, ub.email AS b_email, ub.school AS b_school
      FROM pair_first_msg pfm
      JOIN users ua ON ua.id = pfm.user_a
      JOIN users ub ON ub.id = pfm.user_b
      WHERE pfm.first_msg_at BETWEEN NOW() - INTERVAL '65 days' AND NOW() - INTERVAL '55 days'
        AND NOT EXISTS (
          SELECT 1 FROM match_outcomes mo
          WHERE LEAST(mo.reporter_id, mo.other_user_id) = pfm.user_a
            AND GREATEST(mo.reporter_id, mo.other_user_id) = pfm.user_b
            AND mo.outcome = 'survey_60d'
        )
      ORDER BY pfm.first_msg_at ASC
      LIMIT 20
    `).catch((e) => {
      console.warn('[match-outcomes] pending checkins soft-fail:', e.message);
      return { rows: [] };
    });
    res.json({ count: rows.length, pairs: rows });
  } catch (err) {
    console.error('[match-outcomes] pending-checkins failed:', err);
    res.status(500).json({ error: 'pending checkins query failed' });
  }
});

// ── Bot-admin: summary stats ───────────────────────────────────────────
// "How many real outcome data points do we have?" — drives the
// algorithm-tuning readiness signal. When pairs_with_60d_survey >= 50,
// we have enough data to start regressing scoring weights against
// actual outcomes.
router.get('/bot-admin/match-outcomes-summary', requireBotToken, async (req, res) => {
  await ensureTable();
  try {
    // Soft-fail each query: if the table doesn't exist (fresh deployment,
    // ensureTable race, etc.) or the WITH clause hits a Postgres syntax
    // quirk, return an empty result instead of 500ing the whole cron.
    const safeQuery = (sql) => pool.query(sql).catch((e) => {
      console.warn('[match-outcomes-summary] soft-fail:', e.message);
      return { rows: [] };
    });
    const [byType, pairs] = await Promise.all([
      safeQuery(
        `SELECT outcome, COUNT(*)::int AS n FROM match_outcomes GROUP BY outcome ORDER BY n DESC`
      ),
      // The DISTINCT-on-tuple syntax tripped Postgres on some versions.
      // Rewrote as a subquery that ROW()'s the pair into a single distinct
      // value, which works across PG 12+.
      safeQuery(
        `SELECT COUNT(*)::int AS n FROM (
           SELECT DISTINCT LEAST(reporter_id, other_user_id) AS a,
                  GREATEST(reporter_id, other_user_id) AS b
           FROM match_outcomes WHERE outcome = 'survey_60d'
         ) sub`
      ),
    ]);
    const pairs60d = pairs.rows[0]?.n || 0;
    res.json({
      total_events: byType.rows.reduce((s, r) => s + r.n, 0),
      by_outcome: byType.rows,
      pairs_with_60d_survey: pairs60d,
      retune_ready: pairs60d >= 50,
      retune_progress_pct: Math.min(100, Math.round((pairs60d / 50) * 100)),
    });
  } catch (err) {
    console.error('[match-outcomes] summary failed:', err);
    res.status(500).json({ error: 'summary failed' });
  }
});

module.exports = router;
