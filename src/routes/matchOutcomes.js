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
const { screenMessage } = require('../lib/contentFilter');

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
  'survey_90d',           // 90-day in-app check-in
  'survey_180d',          // 6-month in-app check-in
]);

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_outcomes (
      id              BIGSERIAL PRIMARY KEY,
      reporter_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      other_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      outcome         TEXT NOT NULL,
      details         JSONB,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_match_outcomes_reporter
      ON match_outcomes(reporter_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_match_outcomes_pair
      ON match_outcomes(LEAST(reporter_id, other_user_id), GREATEST(reporter_id, other_user_id));
    -- 2a: index the predicted-score band + stage that the calibration report
    -- (2b) and the weight-learning step (2c) read out of the details JSONB.
    CREATE INDEX IF NOT EXISTS idx_match_outcomes_predscore
      ON match_outcomes(((details->>'predictedScore')));
    CREATE INDEX IF NOT EXISTS idx_match_outcomes_stage
      ON match_outcomes(((details->>'stage')));
  `).catch((e) => console.error('[match_outcomes] ensure table:', e.message));
}

// 2a: the free-text `note` in a check-in is user-generated. Run it through the
// safety filter (egregious content dropped, not stored) and a PII scrub
// (emails / phone numbers / @handles) before it lands — the founder and the
// weight-learning step read these, and a note can name the other person.
function sanitizeDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return details ?? null;
  const out = { ...details };
  if (typeof out.note === 'string' && out.note.trim()) {
    let note = out.note.trim().slice(0, 2000)
      .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi, '[redacted]')  // emails
      .replace(/(\+?\d[\d\s().-]{7,}\d)/g, '[redacted]')        // phone numbers
      .replace(/@[A-Za-z0-9_.]{2,}/g, '[redacted]');           // social handles
    try {
      const screen = screenMessage(note);
      if (screen && screen.action === 'block') note = '[removed by safety filter]';
    } catch { /* screening is best-effort; never block the structured outcome */ }
    out.note = note;
  }
  return out;
}

// ── POST /users/me/match-outcomes ──────────────────────────────────────
// User logs an event about a specific match. Most often used by the
// 60-day in-app survey (when we ship it) or by the founder hand-entering
// notes from a phone call.
router.post('/me/match-outcomes', requireAuth, async (req, res) => {
  await ensureTable();
  const { otherUserId, outcome, details } = req.body || {};
  // user ids are UUIDs — the old parseInt() check rejected every real id
  // (NaN → 400), so this endpoint never worked. Validate as a non-empty string.
  if (!otherUserId || typeof otherUserId !== 'string') return res.status(400).json({ error: 'otherUserId required' });
  if (!ALLOWED_OUTCOMES.has(outcome)) return res.status(400).json({ error: 'invalid outcome' });

  try {
    await pool.query(
      `INSERT INTO match_outcomes (reporter_id, other_user_id, outcome, details)
       VALUES ($1, $2, $3, $4)`,
      [req.user.id, otherUserId, outcome, sanitizeDetails(details)]
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
    const safeQuery = (sql) => pool.query(sql).catch((e) => {
      console.warn('[match-outcomes-summary] soft-fail:', e.message);
      return { rows: [] };
    });
    const [byType, pairs, bands] = await Promise.all([
      safeQuery(
        `SELECT outcome, COUNT(*)::int AS n FROM match_outcomes GROUP BY outcome ORDER BY n DESC`
      ),
      safeQuery(
        `SELECT COUNT(*)::int AS n FROM (
           SELECT DISTINCT LEAST(reporter_id, other_user_id) AS a,
                  GREATEST(reporter_id, other_user_id) AS b
           FROM match_outcomes WHERE outcome = 'survey_60d'
         ) sub`
      ),
      // Calibration: bucket DECIDED outcomes by the score we PREDICTED for the
      // pair (details.predictedScore, sent by the client), and count how many
      // turned out positive. A predictive engine shows success rising with the
      // band. 'still_chatting' (meet pending) is excluded from the denominator.
      safeQuery(
        `SELECT
           CASE
             WHEN (details->>'predictedScore')::numeric >= 90 THEN '90+'
             WHEN (details->>'predictedScore')::numeric >= 80 THEN '80-89'
             WHEN (details->>'predictedScore')::numeric >= 70 THEN '70-79'
             WHEN (details->>'predictedScore')::numeric >= 60 THEN '60-69'
             ELSE '<60'
           END AS band,
           COUNT(*)::int AS n,
           COUNT(*) FILTER (
             WHERE outcome = 'met_in_person' OR details->>'answer' = 'yes'
           )::int AS success
         FROM match_outcomes
         WHERE (details->>'predictedScore') ~ '^[0-9.]+$'
           AND outcome <> 'still_chatting'
         GROUP BY band`
      ),
    ]);
    const pairs60d = pairs.rows[0]?.n || 0;
    const BAND_ORDER = ['90+', '80-89', '70-79', '60-69', '<60'];
    const by_band = (bands.rows || [])
      .map((r) => ({
        band: r.band,
        n: r.n,
        success: r.success,
        success_rate_pct: r.n ? Math.round((r.success / r.n) * 100) : 0,
      }))
      .sort((a, b) => BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band));
    res.json({
      total_events: byType.rows.reduce((s, r) => s + r.n, 0),
      by_outcome: byType.rows,
      pairs_with_60d_survey: pairs60d,
      retune_ready: pairs60d >= 50,
      retune_progress_pct: Math.min(100, Math.round((pairs60d / 50) * 100)),
      by_band,
    });
  } catch (err) {
    console.error('[match-outcomes] summary failed:', err);
    res.status(500).json({ error: 'summary failed' });
  }
});

// ── 2c: Bot-admin weight-learning scaffolding ──────────────────────────────
// Proposes recalibrated PART-0 weights from real outcomes — REGULARISED (shrunk
// toward the CURRENT weights until N is large) and MANUAL: it never edits
// scoring.js. The founder reviews this quarterly and, if a proposal holds up,
// updates QUESTION_POINTS in services/scoring.js AND the app's quizStore.ts in
// lockstep, then recomputes. Dormant (ready:false) until enough decided outcomes.
router.get('/bot-admin/weight-learning', requireBotToken, async (req, res) => {
  await ensureTable();
  const { QUESTION_POINTS, OPTION_COUNTS } = require('../services/scoring');
  const MIN_N = 50;

  // Option index out of the wire shape ({type,index} | {index} | bare number).
  const idx = (v) => {
    if (v == null) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    if (typeof v === 'object') return idx(v.index ?? v.value);
    return null;
  };
  const POSITIVE = new Set(['met_in_person', 'moved_in_together', 'lease_signed']);
  const NEGATIVE = new Set(['decided_not_to_continue', 'lost_contact', 'ended_roommate_relationship']);
  const isPositive = (o, details) => {
    if (POSITIVE.has(o)) return true;
    if (NEGATIVE.has(o)) return false;
    const ans = details && details.answer;
    if (ans === 'yes') return true;
    if (ans === 'no')  return false;
    return null; // unknown — excluded from the denominator
  };

  try {
    const { rows } = await pool.query(`
      SELECT mo.outcome, mo.details, ra.answers AS a, oa.answers AS b
        FROM match_outcomes mo
        LEFT JOIN quiz_answers ra ON ra.user_id = mo.reporter_id
        LEFT JOIN quiz_answers oa ON oa.user_id = mo.other_user_id
       WHERE mo.outcome <> 'still_chatting'`);

    const liveIds = Object.keys(QUESTION_POINTS).map(Number);
    const stat = {}; for (const q of liveIds) stat[q] = { posSum: 0, posN: 0, negSum: 0, negN: 0 };
    let decided = 0;

    for (const r of rows) {
      const pos = isPositive(r.outcome, r.details);
      if (pos === null) continue;
      decided++;
      const A = r.a || {}, B = r.b || {};
      for (const q of liveIds) {
        const ai = idx(A[q]), bi = idx(B[q]);
        if (ai == null || bi == null) continue;
        const maxDiff = Math.max(1, (OPTION_COUNTS[q] || 4) - 1);
        const agree = 1 - Math.abs(ai - bi) / maxDiff;   // 0..1
        if (pos) { stat[q].posSum += agree; stat[q].posN++; }
        else     { stat[q].negSum += agree; stat[q].negN++; }
      }
    }

    const lambda = Math.min(1, decided / 300);   // shrink toward prior until N is large
    const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
    const proposals = liveIds.map(q => {
      const s = stat[q];
      const posAvg = s.posN ? s.posSum / s.posN : null;
      const negAvg = s.negN ? s.negSum / s.negN : null;
      // Predictive lift: do pairs that AGREED on this question succeed more than
      // pairs that disagreed? Positive lift → the question separates winners → up-weight.
      const signal  = (posAvg != null && negAvg != null) ? (posAvg - negAvg) : 0;  // -1..1
      const current = QUESTION_POINTS[q];
      const dataTarget = Math.max(0, current * (1 + signal));
      const proposed   = Math.round(current * (1 - lambda) + dataTarget * lambda);
      return { qid: q, current, posAvgAgreement: r2(posAvg), negAvgAgreement: r2(negAvg), predictiveSignal: r2(signal), proposedWeight: proposed };
    }).sort((a, b) => (b.predictiveSignal ?? 0) - (a.predictiveSignal ?? 0));

    res.json({
      ready: decided >= MIN_N,
      decided_outcomes: decided,
      shrink_lambda: r2(lambda),
      method: 'per-question agreement lift (positive vs negative outcomes), shrunk toward current weights by lambda = min(1, N/300)',
      action: decided >= MIN_N
        ? 'HUMAN REVIEW before applying. If a proposal holds, edit QUESTION_POINTS in services/scoring.js AND app quizStore.ts in lockstep, then recompute.'
        : `Illustrative only — need >= ${MIN_N} decided outcomes (have ${decided}).`,
      proposals,
    });
  } catch (err) {
    console.error('[weight-learning] failed:', err);
    res.status(500).json({ error: 'weight-learning failed' });
  }
});

module.exports = router;
