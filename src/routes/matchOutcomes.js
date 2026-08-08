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
// Spec §5 — the stress check-in item: "How did the last stressful stretch go?"
// Closed vocab; anything else is dropped rather than stored.
const STRESS_STRETCH_VALUES = new Set(['smooth', 'bumpy', 'clashed']);

const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { screenMessage } = require('../lib/contentFilter');
const sentry = require('../utils/sentry');
const DISCORD_HOOK = process.env.DISCORD_WEBHOOK_URL || '';

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

// ── Calibration helpers (2b) — pure, no I/O ────────────────────────────────
// The "does this actually work?" report buckets every ANSWERED outcome by the
// score we PREDICTED for that pair and reports the REAL success rate per band.
// A calibrated engine shows success rising with the band. These functions are
// the single source of truth for the bucketing + success definition (so the
// unit tests cover them directly); the route is a thin DB wrapper around them.
//
// `min` is the inclusive lower bound of each band; the top band's upper bound
// is 100 (scores never exceed it). Frontend sorts high→low by `min`. Kept in
// lockstep with docs/BACKEND_OUTCOME_LEARNING.md §2a.
const CALIBRATION_BANDS = [
  { band: '85–100',   min: 85 },
  { band: '70–84',    min: 70 },
  { band: '55–69',    min: 55 },
  { band: 'Below 55', min: 0  },
];
const RETENTION_STAGES = new Set(['day30', 'day60', 'day90', 'month6']);

// These rows come from `details->>'key'`, so a MISSING key is SQL NULL → JS
// null, not undefined. Number(null) and Number('') are both 0 rather than NaN,
// so a plain Number.isFinite(Number(x)) check reads a missing value as a real
// zero. For a rating that means an unresolved check-in scores as
// answered-and-failed, biasing every published success rate downward. Shared
// (via router._calibration) so the outcome readers can't drift apart on it.
const isBlank = (v) => v === null || v === undefined || v === '';
/** A 1–5 rating, or undefined when genuinely absent. Never 0-by-coercion. */
const ratingOf = (v) => (!isBlank(v) && Number.isFinite(Number(v)) ? Number(v) : undefined);

// A RESOLVED response we can score. Pending ('notyet') and rows without a
// decisive answer are excluded from the denominator — an unresolved check-in
// is not evidence for OR against the prediction (mirrors the existing summary
// query, which excludes 'still_chatting').
function isAnswered({ stage, answer, rating }) {
  if (stage === 'meet48') return answer === 'yes' || answer === 'no';
  if (RETENTION_STAGES.has(stage)) {
    return Number.isFinite(rating) || answer === 'yes' || answer === 'no';
  }
  return false;
}

// Did the pairing succeed? meet48 → they actually met (answer 'yes').
// Retention → still happy (rating >= 4). Per BACKEND_OUTCOME_LEARNING §2a.
function isSuccess({ stage, answer, rating }) {
  if (stage === 'meet48') return answer === 'yes';
  if (RETENTION_STAGES.has(stage)) return Number.isFinite(rating) && rating >= 4;
  return false;
}

function bandFor(score) {
  for (const b of CALIBRATION_BANDS) if (score >= b.min) return b;
  return CALIBRATION_BANDS[CALIBRATION_BANDS.length - 1];
}

// rows: [{ predictedScore, stage, answer, rating }]. Returns the aggregate
// calibration payload — cohort rates only, never an individual's outcome. No
// answered data → { ok:false } (the honest "still gathering" state); never
// padded, never fabricated.
function computeCalibration(rows) {
  const buckets = new Map(); // band label -> { total, success }
  let totalSample = 0;
  for (const r of rows || []) {
    if (isBlank(r.predictedScore)) continue;          // null must not bucket as 0
    const score = Number(r.predictedScore);
    if (!Number.isFinite(score)) continue;            // must carry a prediction
    const rating = ratingOf(r.rating);
    const item = { stage: r.stage, answer: r.answer, rating };
    if (!isAnswered(item)) continue;                  // only resolved outcomes
    totalSample++;
    const { band } = bandFor(score);
    const cur = buckets.get(band) || { total: 0, success: 0 };
    cur.total++;
    if (isSuccess(item)) cur.success++;
    buckets.set(band, cur);
  }
  if (totalSample === 0) return { ok: false };
  const bands = CALIBRATION_BANDS
    .filter((b) => buckets.has(b.band))
    .map((b) => {
      const { total, success } = buckets.get(b.band);
      return {
        band: b.band,
        min: b.min,
        actualSuccess: Math.round((success / total) * 1000) / 1000, // 0–1, 3dp
        sampleSize: total,
      };
    });
  return { ok: true, totalSample, bands };
}

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
    -- Promote the prediction ↔ outcome PAIR to first-class columns (was only in
    -- the details JSONB). The validation loop reads these directly; both are
    -- written the moment an outcome arrives so no labeled pair is ever lost.
    ALTER TABLE match_outcomes ADD COLUMN IF NOT EXISTS predicted_score NUMERIC;
    ALTER TABLE match_outcomes ADD COLUMN IF NOT EXISTS predicted_tier  TEXT;
    CREATE INDEX IF NOT EXISTS idx_match_outcomes_predcol
      ON match_outcomes(predicted_score);
    -- Stress dimension validation (spec §5). Same prediction↔outcome shape as
    -- predicted_score/predicted_tier above: stress_stretch is what the pair
    -- REPORTED ('smooth' | 'bumpy' | 'clashed'), predicted_pattern is what the
    -- clash matrix PREDICTED for them at check-in time. Storing both as columns
    -- is what lets the cohort query answer the only question that matters:
    -- did flagged-and-pacted pairs actually clash less?
    ALTER TABLE match_outcomes ADD COLUMN IF NOT EXISTS stress_stretch    TEXT;
    ALTER TABLE match_outcomes ADD COLUMN IF NOT EXISTS predicted_pattern TEXT;
    CREATE INDEX IF NOT EXISTS idx_match_outcomes_stress
      ON match_outcomes(predicted_pattern, stress_stretch)
      WHERE predicted_pattern IS NOT NULL;
  `).catch((e) => console.error('[match_outcomes] ensure table:', e.message));
  // One-time backfill of the new columns from existing rows' details JSONB.
  if (!_predColsBackfilled) {
    _predColsBackfilled = true;
    await pool.query(`
      UPDATE match_outcomes
         SET predicted_score = NULLIF(details->>'predictedScore','')::numeric
       WHERE predicted_score IS NULL AND details->>'predictedScore' ~ '^[0-9.]+$'`).catch(() => {});
    await pool.query(`
      UPDATE match_outcomes
         SET predicted_tier = details->>'predictedTier'
       WHERE predicted_tier IS NULL AND details->>'predictedTier' IS NOT NULL`).catch(() => {});
  }
}
let _predColsBackfilled = false;

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

// Safety push. A check-in note that trips the crisis (self-harm) or threat
// filter shouldn't wait for someone to pull the flags endpoint — page the
// founder now. Fire-and-forget: a webhook failure must never reach the student,
// and the excerpt is the ALREADY PII-redacted stored note, capped short.
function maybePageSafety(reporterId, rawDetails, sanitized) {
  try {
    const rawNote = rawDetails && typeof rawDetails.note === 'string' ? rawDetails.note : '';
    if (!rawNote.trim()) return;
    const screen = screenMessage(rawNote);
    const isCrisis = !!screen.crisis;                                      // self-harm language
    const isThreat = screen.action === 'block' && screen.category === 'threat';
    if (!isCrisis && !isThreat) return;
    pageCheckinSafetyFlag({
      reporterId,
      stage: (rawDetails && rawDetails.stage) || null,
      kind:  isCrisis ? 'crisis' : 'threat',
      noteExcerpt: (sanitized && typeof sanitized.note === 'string' ? sanitized.note : '').slice(0, 300),
    }).catch(() => {});
  } catch { /* never throw into the request path */ }
}

async function pageCheckinSafetyFlag({ reporterId, stage, kind, noteExcerpt }) {
  const crisis = kind === 'crisis';
  try {
    sentry.captureError(new Error('signal:checkin_safety_flag'), { kind, reporterId, stage });
  } catch { /* best-effort */ }
  if (!DISCORD_HOOK) return;
  await fetch(DISCORD_HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: crisis
          ? '\u{1F6A8} signal:checkin_safety_flag — CRISIS'
          : '\u{1F6A8} signal:checkin_safety_flag — THREAT',
        description: crisis
          ? 'A student’s check-in note tripped the self-harm / crisis filter. Reach out — they may need support (988).'
          : 'A student’s check-in note tripped the threat filter. Review and follow up.',
        color: 0xC0392B,
        fields: [
          { name: 'Reporter (user id)', value: `\`${reporterId || '?'}\``, inline: true },
          { name: 'Stage', value: `\`${stage || '?'}\``, inline: true },
          { name: 'Note (PII-redacted)', value: (noteExcerpt || '—').slice(0, 900), inline: false },
        ],
        footer: { text: 'Check-in safety • paged on crisis/threat filter hit' },
      }],
    }),
  }).catch(() => {});
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
    const sanitized = sanitizeDetails(details);
    // Promote the prediction ↔ outcome pair into columns as it arrives (still
    // kept in details too, for back-compat with the calibration reader).
    const rawPred = sanitized && sanitized.predictedScore;
    const predScore = /^[0-9.]+$/.test(String(rawPred ?? '')) ? Number(rawPred) : null;
    const predTier  = sanitized && typeof sanitized.predictedTier === 'string' ? sanitized.predictedTier : null;

    // Stress validation (spec §5): "How did the last stressful stretch go?"
    // Enum-guarded — anything else is dropped rather than stored, so the cohort
    // query never has to clean free-text. Absent today (the app ships the item in
    // the same lockstep release), which is why this is optional, not required.
    const rawStretch = sanitized && sanitized.stressStretch;
    const stressStretch = STRESS_STRETCH_VALUES.has(String(rawStretch))
      ? String(rawStretch) : null;

    // The prediction this outcome is scored against. Read server-side from the
    // pair's stored row — NEVER from the payload, so a client can't relabel what
    // we predicted and quietly launder the validation loop.
    // Matched either direction rather than assuming the stored row is sorted —
    // JS .sort() and Postgres LEAST() need not agree on collation, and a missed
    // row here would silently label the outcome "unpredicted".
    let predPattern = null;
    if (stressStretch) {
      const { rows: up } = await pool.query(
        `SELECT under_pressure->>'pattern' AS pattern
           FROM compatibility_scores
          WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)
          LIMIT 1`,
        [req.user.id, otherUserId],
      ).catch(() => ({ rows: [] }));
      predPattern = up[0]?.pattern || null;
    }

    await pool.query(
      `INSERT INTO match_outcomes (reporter_id, other_user_id, outcome, details, predicted_score, predicted_tier, stress_stretch, predicted_pattern)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [req.user.id, otherUserId, outcome, sanitized, predScore, predTier, stressStretch, predPattern]
    );
    // W2 — mirror every recurring check-in into the pair ledger as an `outcome`
    // event, so the longitudinal record and the check-in survey are ONE dataset
    // rather than two that have to be reconciled later. Best-effort and
    // consent-gated inside the service: a pair outside the consented cohort
    // records nothing here, and a ledger hiccup never fails the check-in itself.
    //
    // `hardStatus` is the terminal read (still_together | room_change |
    // lease_break | ended); `rating` is the 1-5 self-report. Both ride the same
    // event so the trajectory and the terminal outcome share a timestamp.
    (async () => {
      try {
        const pe = require('../services/pairEvents');
        const pairKey = [String(req.user.id), String(otherUserId)].sort().join(':');
        await pe.ensureTable();
        if (!(await pe.hasConsent(pairKey))) return;
        const raw = sanitized || {};
        const HARD = new Set(['still_together', 'room_change', 'lease_break', 'ended']);
        const hardStatus = HARD.has(String(raw.hardStatus)) ? String(raw.hardStatus) : null;
        const rating = Number.isFinite(Number(raw.rating)) ? Number(raw.rating) : null;
        // A terminal status is its own subtype so the North Star query can find
        // it directly; anything else is an ordinary recurring check-in.
        const subtype = hardStatus && hardStatus !== 'still_together' ? hardStatus : 'checkin';
        await pe.persistBatch([{
          // Deterministic id ⇒ a retried check-in dedups instead of double-counting.
          id: `mo:${req.user.id}:${otherUserId}:${outcome}:${raw.stage || 'na'}`,
          type: 'pair_event',
          payload: {
            pairId: String(otherUserId),
            t: Date.now(),
            kind: 'outcome',
            subtype,
            value: rating,
            episodeId: typeof raw.episodeId === 'string' ? raw.episodeId : undefined,
            meta: {
              stage: raw.stage ?? null,
              hardStatus,
              ...(typeof raw.reason === 'string' ? { reason: raw.reason.slice(0, 120) } : {}),
            },
          },
        }], String(req.user.id));
      } catch (e) {
        console.error('[match-outcomes] pair-ledger mirror failed:', e.message);
      }
    })();

    res.json({ recorded: true });
    // Page on a crisis/threat note AFTER responding — best-effort, non-blocking.
    maybePageSafety(req.user.id, details, sanitized);
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

// ── GET /match-outcomes/calibration ────────────────────────────────────
// The "does this actually work?" proof. Buckets every ANSWERED outcome by the
// score we PREDICTED for that pair and reports the REAL success rate per band.
// Aggregate cohort rates ONLY — never an individual's outcome, no user ids, no
// answers. Any logged-in user may call it (no admin gate). Honest by
// construction: no data → { ok:false }; never padded or seeded.
// Outcome-Learning Loop A honesty floor for the campus split below — same
// value as utils/cohortGate.ts's MIN_COHORT_SAMPLE and this route's own
// sibling frictionValidation.js. A thin campus falls back to the global
// pool rather than publish a curve nobody earned yet.
const CAMPUS_SPLIT_FLOOR = 30;

async function calibrationRows(schoolFilter) {
  // Prefer the promoted predicted_score COLUMN, falling back to the details
  // JSONB. The column was added precisely so the validation loop wouldn't
  // depend on a JSON path, but this reader still only looked at the JSONB —
  // so a row carrying the column without the JSON key would have been
  // invisible to the very report it exists to feed. Identical results today
  // (one writer populates both from the same value); robust if that changes.
  // No alias on match_outcomes — keeps the SELECT/WHERE expressions
  // byte-identical to the pre-campus-split query (still unambiguous: `users`
  // has none of predicted_score/details/stage/answer/rating), so the join
  // below only ever ADDS a clause rather than rewriting the ones that already
  // existed and are covered by existing tests.
  const params = [];
  let schoolJoin = '';
  let schoolClause = '';
  if (schoolFilter) {
    // reporter_id's own school is the pair's campus — matching is same-campus
    // only, so the reporter's school already implies the pair's campus.
    schoolJoin = 'JOIN users ON users.id = match_outcomes.reporter_id';
    schoolClause = "AND users.school IS NOT NULL AND lower(trim(users.school)) = lower(trim($1))";
    params.push(schoolFilter);
  }
  const { rows } = await pool.query(`
    SELECT COALESCE(predicted_score::text, details->>'predictedScore') AS predicted_score,
           details->>'stage'          AS stage,
           details->>'answer'         AS answer,
           details->>'rating'         AS rating
      FROM match_outcomes
      ${schoolJoin}
     WHERE COALESCE(predicted_score::text, details->>'predictedScore') ~ '^[0-9.]+$'
       ${schoolClause}`, params);
  return rows.map((r) => ({
    predictedScore: r.predicted_score, stage: r.stage, answer: r.answer, rating: r.rating,
  }));
}

router.get('/match-outcomes/calibration', requireAuth, async (req, res) => {
  await ensureTable();
  try {
    // docs/specs/outcome-learning.md §1, Loop A: "per campus once the campus
    // clears the floor; global otherwise." Try the caller's own campus first;
    // fall back to pooling every school when that campus is too thin to mean
    // anything on its own (or the caller has no school on file). Response
    // shape is identical either way — the frontend needs no changes.
    const school = req.user.school && req.user.school.trim();
    let result = null;
    if (school) {
      const campusResult = computeCalibration(await calibrationRows(school));
      if (campusResult.ok && campusResult.totalSample >= CAMPUS_SPLIT_FLOOR) {
        result = campusResult;
      }
    }
    if (!result) {
      result = computeCalibration(await calibrationRows(null));
    }
    if (!result.ok) return res.status(404).json({ ok: false });
    return res.json(result);
  } catch (err) {
    // Honest degrade: a failed aggregation reads as "still gathering", never a
    // fabricated curve. The frontend treats ok:false / 404 identically.
    console.error('[match-outcomes] calibration failed:', err);
    return res.status(404).json({ ok: false });
  }
});

// ── Bot-admin: pending 60-day check-ins ────────────────────────────────
// For the daily check-in cron. Returns matched pairs (both sides
// accepted a connect_request) whose FIRST mutual message exchange was
// ~60 days ago AND whom we haven't already checked in on. The bot
// pings the founder in Discord with each pair so the founder reaches
// out personally — phone calls beat surveys at low N.

// The shared internal-endpoint guard. This was previously a try/require with an
// inline fallback — and because middleware/botAuth.js did not exist, the
// fallback is what actually ran: it compared the secret with a plain string
// comparison, which leaks how much of it matched through response timing.
// Requiring directly makes a missing module a loud boot error rather than a
// silent downgrade to the weaker check.
const { requireBotToken } = require('../middleware/botAuth');

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

// ── GET /bot-admin/match-outcomes-flags ────────────────────────────────────
// The review surface behind the check-in promise: "if you flag a problem, our
// safety team can follow up." The summary above is aggregate-only, so a student
// who wrote a note or rated the situation poorly was invisible to anyone without
// raw DB access. This surfaces the check-ins that warrant a human look — a
// written note, a low happiness rating (1-2), or a "decided not to continue" —
// so the founder/safety team can actually act. Bot/founder-gated + internal
// only (it includes reporter identity so they can reach out); never client.
router.get('/bot-admin/match-outcomes-flags', requireBotToken, async (req, res) => {
  await ensureTable();
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const { rows } = await pool.query(
      `SELECT id, reporter_id, other_user_id, outcome, details, created_at
         FROM match_outcomes
        WHERE (COALESCE(btrim(details->>'note'), '') <> ''
               OR (details->>'rating') ~ '^[12]$'
               OR outcome = 'decided_not_to_continue')
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit],
    );
    const flags = rows.map((r) => {
      const d = r.details || {};
      // Why this row surfaced — lets the reviewer triage at a glance.
      const reasons = [];
      if (typeof d.note === 'string' && d.note.trim()) reasons.push('note');
      if (['1', '2', 1, 2].includes(d.rating)) reasons.push('low_rating');
      if (r.outcome === 'decided_not_to_continue') reasons.push('ended');
      return {
        id:          r.id,
        reporterId:  r.reporter_id,
        otherUserId: r.other_user_id,
        outcome:     r.outcome,
        stage:       d.stage ?? null,
        rating:      d.rating ?? null,
        note:        d.note ?? null,
        reasons,
        createdAt:   r.created_at,
      };
    });
    res.json({ count: flags.length, flags });
  } catch (err) {
    console.error('[match-outcomes] flags failed:', err);
    res.status(500).json({ error: 'flags failed' });
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

// ── Deep-matching #2: train per-dimension shapes from pairing_outcomes ───────
// Fits + gates each dimension's basis (dist/mean/min/max/prod) against real
// "did it work?" outcomes and persists certified shapes to dimension_models.
// Until move-in / room-change outcomes accrue this certifies nothing → scoring
// stays on today's curve, bit-for-bit. Bot-gated; safe to call repeatedly.
// Wire to a periodic cron once outcomes start landing.
router.post('/bot-admin/train-dimension-models', requireBotToken, async (req, res) => {
  try {
    const { trainDimensionModels, loadCertifiedModels } = require('../services/dimensionModel');
    const summary = await trainDimensionModels();
    await loadCertifiedModels({ force: true }); // refresh the scorer's cache
    const certified = summary.filter(s => s.certified);
    res.json({
      trained: summary.length,
      certified: certified.length,
      note: certified.length === 0
        ? 'No dimension cleared the gate — every dimension stays dist-only (today, bit-for-bit). Expected until real move-in/room-change outcomes accrue.'
        : 'Certified shapes are live; recompute matches to apply to stored scores.',
      summary,
    });
  } catch (err) {
    console.error('[train-dimension-models] failed:', err);
    res.status(500).json({ error: 'training failed' });
  }
});

// ── Deep-matching #5: extract text-insight vectors for consenting users ──────
// Reads each opted-in user's own free text and banks the derived construct
// vector (never the text). Idempotent: unchanged text is skipped via source_hash.
// Run on a cron once users opt in; bot-gated.
router.post('/bot-admin/extract-text-insights', requireBotToken, async (req, res) => {
  try {
    const textInsight = require('../services/textInsight');
    // Current consent = latest row per user for the textInsight category.
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (user_id) user_id, allowed
         FROM consent_log WHERE category = $1
        ORDER BY user_id, created_at DESC`,
      [textInsight.TEXT_INSIGHT_CONSENT],
    );
    const consenting = rows.filter(r => r.allowed === true).map(r => r.user_id);
    const counts = {};
    for (const uid of consenting) {
      const status = await textInsight.extractForUser(uid);
      counts[status] = (counts[status] || 0) + 1;
    }
    res.json({ consenting: consenting.length, results: counts });
  } catch (err) {
    console.error('[extract-text-insights] failed:', err);
    res.status(500).json({ error: 'extraction failed' });
  }
});

// Fit + gate each LLM construct against held-out pairing_outcomes; persist
// certified shapes to text_insight_models. Nothing certifies until real outcomes
// accrue ⇒ every construct weight stays 0 ⇒ scoring is today, bit-for-bit.
router.post('/bot-admin/train-text-insights', requireBotToken, async (req, res) => {
  try {
    const textInsight = require('../services/textInsight');
    const summary = await textInsight.trainFeatures();
    await textInsight.loadCertifiedModels({ force: true });
    const certified = summary.filter(s => s.certified);
    res.json({
      trained: summary.length,
      certified: certified.length,
      note: certified.length === 0
        ? 'No construct beat the no-feature model on held-out outcomes — every construct stays weight 0 (today). Expected until outcomes accrue.'
        : 'Certified constructs are live; recompute matches to apply.',
      summary,
    });
  } catch (err) {
    console.error('[train-text-insights] failed:', err);
    res.status(500).json({ error: 'training failed' });
  }
});

// Pure calibration internals, exposed for unit tests (no DB required).
router._calibration = { computeCalibration, isAnswered, isSuccess, bandFor, CALIBRATION_BANDS, ratingOf, isBlank };

module.exports = router;
