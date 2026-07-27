const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { calculateCompatibility, generateWhyMatched, topFrictionTopic } = require('../services/scoring');
const { fallbackHeadline } = require('../services/stressInsight');
const { loadCertifiedModels } = require('../services/dimensionModel');
const { loadDrift } = require('../services/pulseDrift');
const { horizonFromMoveIn } = require('../services/trajectory');
const textInsight = require('../services/textInsight');
const { derivePersonality } = require('../services/personality');
const { computePersonalityMatch, calibratePersonality } = require('../services/personalityPairing');
const { notDemo } = require('../lib/demoFilter');
const { MATCH_MIN_SCORE } = require('../lib/matchConfig');
const { textToSpeech, transcribe } = require('../services/voice');
const { analyzeVoiceEmotion } = require('../services/voiceEmotion');
const analytics = require('../services/analytics');
const multer = require('multer');

// In-memory upload for voice-interview audio answers (<= 25 MB).
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 25 * 1024 * 1024 },
});
// Wrap multer so its errors return a clean 400 instead of bubbling to the
// global error handler as an opaque 500.
function voiceAudioUpload(req, res, next) {
  voiceUpload.single('audio')(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'That recording is too long — keep each answer shorter.'
      : (err.message || 'Audio upload was rejected.');
    res.status(400).json({ error: msg });
  });
}

// Cap per free-text answer to keep one bad actor from stuffing 10MB
// of garbage into the quiz_answers JSONB column. 5000 chars is roughly
// 1000 words — far more than any legitimate clinical-quiz reflection.
const MAX_TEXT_ANSWER_CHARS = 5000;
const MIN_QUESTION_ID  = 1;
const MAX_QUESTION_ID  = 100;   // Headroom above the current 17-question set (max scored id 67)
                                // so adding questions doesn't require a
                                // simultaneous backend deploy.
const MAX_TOTAL_ANSWERS = 200;  // Stops a single submit from carrying
                                // unbounded garbage keys.

function validateAnswers(answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return 'answers object required';
  }
  const keys = Object.keys(answers);
  if (keys.length > MAX_TOTAL_ANSWERS) {
    return `too many answers (${keys.length} > ${MAX_TOTAL_ANSWERS})`;
  }
  for (const [k, v] of Object.entries(answers)) {
    // Question IDs must be small positive integers in the documented range.
    const qid = Number(k);
    if (!Number.isInteger(qid) || qid < MIN_QUESTION_ID || qid > MAX_QUESTION_ID) {
      return `answer ${k}: question id out of range`;
    }
    if (!v || typeof v !== 'object') {
      return `answer ${k}: malformed`;
    }
    if (v.type === 'text' || v.type === 'freetext') {
      if (typeof v.text !== 'string') return `answer ${k}: text must be a string`;
      if (v.text.length > MAX_TEXT_ANSWER_CHARS) {
        return `answer ${k}: text exceeds ${MAX_TEXT_ANSWER_CHARS} char limit`;
      }
    } else if (v.type === 'option' || v.type === 'choice') {
      // Accept either `index` (zero-based) or `value` (numeric). Both
      // must be small integers — scoring engine treats anything else as
      // invalid anyway.
      const candidate = v.index !== undefined ? v.index : v.value;
      if (!Number.isInteger(candidate) || candidate < 0 || candidate > 20) {
        return `answer ${k}: option index out of range`;
      }
    } else {
      return `answer ${k}: unknown type ${v.type}`;
    }
  }
  return null;
}

// ── POST /quiz/save ───────────────────────────────────────────────────────
// Save quiz progress (called after every answer for save & resume)
router.post('/save', requireAuth, async (req, res) => {
  try {
    const { answers } = req.body || {};
    const err = validateAnswers(answers);
    if (err) return res.status(400).json({ error: err });

    await pool.query(
      `INSERT INTO quiz_answers (user_id, answers, completed)
       VALUES ($1, $2, FALSE)
       ON CONFLICT (user_id) DO UPDATE
       SET answers = $2, updated_at = NOW()`,
      [req.user.id, JSON.stringify(answers)]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save progress' });
  }
});

// ── GET /quiz/progress ────────────────────────────────────────────────────
// Resume: return saved answers
router.get('/progress', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT answers, completed FROM quiz_answers WHERE user_id = $1',
      [req.user.id]
    );

    if (!rows[0]) return res.json({ answers: null, completed: false });
    res.json({ answers: rows[0].answers, completed: rows[0].completed });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

// ── POST /quiz/preview-matches ────────────────────────────────────────────
// Mid-quiz hook: show the user 1-3 already-completed students whose answers
// are most compatible with whatever they've answered so far. Drives quiz
// completion — empirically, "here's who you're already matching with" is
// a much stronger pull than a generic progress bar. Does NOT persist
// anything to compatibility_scores; final scoring still happens on submit.
router.post('/preview-matches', optionalAuth, async (req, res) => {
  try {
    const { isFounderUser } = require('../utils/founders');
    const authed = !!req.user;

    // AUTHED: prefer the caller's REAL already-scored matches — literally "who
    // you've matched with so far," independent of in-progress answers.
    if (authed) {
      const includeDemos = isFounderUser(req.user) && process.env.DEMO_FEED === 'true';
      const demoFilter = includeDemos ? '' : `AND ${notDemo('u.email')}`;
      const { rows: stored } = await pool.query(
        `SELECT u.id AS user_id, u.first_name, u.last_name, u.photo_url, u.school, cs.score
           FROM compatibility_scores cs
           JOIN users u ON u.id = (CASE WHEN cs.user_a = $1 THEN cs.user_b ELSE cs.user_a END)
          WHERE (cs.user_a = $1 OR cs.user_b = $1)
            AND cs.score >= ${MATCH_MIN_SCORE} AND cs.is_hard_blocked = FALSE
            AND u.is_paused = FALSE AND u.is_banned = FALSE AND u.quiz_completed = TRUE
            ${demoFilter}
          ORDER BY cs.score DESC
          LIMIT 3`,
        [req.user.id],
      );
      if (stored.length > 0) {
        return res.json({
          matches: stored.map(r => ({
            userId:      r.user_id,
            firstName:   r.first_name,
            lastInitial: (r.last_name || '').slice(0, 1).toUpperCase(),
            photoUrl:    r.photo_url,
            school:      r.school,
            score:       Math.round(r.score),
          })),
        });
      }
    }

    // ON-THE-FLY — score the in-progress answers against the pool. Runs for an
    // authed first-time taker (no scores yet) AND for ANONYMOUS quiz-takers
    // (the normal pre-signup flow). PRIVACY: an anonymous caller is ONLY scored
    // against the DEMO pool — real students' names/photos are never returned to
    // an unauthenticated request.
    const { answers } = req.body || {};
    const err = validateAnswers(answers);
    if (err) return res.status(400).json({ error: err });

    const answerCount = Object.keys(answers || {}).length;
    if (answerCount < 5) return res.json({ matches: [] });

    let candidates;
    if (authed) {
      const includeDemos = isFounderUser(req.user) && process.env.DEMO_FEED === 'true';
      const demoFilter = includeDemos ? '' : `AND ${notDemo('u.email')}`;
      ({ rows: candidates } = await pool.query(
        `SELECT qa.user_id, qa.answers, u.first_name, u.last_name, u.photo_url, u.school
           FROM quiz_answers qa
           JOIN users u ON u.id = qa.user_id
          WHERE qa.completed = TRUE
            AND qa.user_id != $1
            AND u.is_paused = FALSE
            ${demoFilter}`,
        [req.user.id]));
    } else {
      ({ rows: candidates } = await pool.query(
        `SELECT qa.user_id, qa.answers, u.first_name, u.last_name, u.photo_url, u.school
           FROM quiz_answers qa
           JOIN users u ON u.id = qa.user_id
          WHERE qa.completed = TRUE
            AND u.is_paused = FALSE
            AND u.email LIKE '%@haveniq-demo.edu'`));
    }

    // Normalize the wire shape into the flat { questionId: number } map
    // the scoring engine expects. Frontend stores three answer shapes:
    //   { type: 'option', index: N }, { type: 'scale', value: N }, { type: 'text', text: string }
    // We pull `index` first, then fall back to `value`. Text answers are
    // skipped — scoring already tolerates missing IDs via `??`.
    const normalize = (raw) => {
      const flat = {};
      for (const [k, v] of Object.entries(raw || {})) {
        if (typeof v === 'number') { flat[k] = v; continue; }
        if (v && typeof v === 'object') {
          if (typeof v.index === 'number') flat[k] = v.index;
          else if (typeof v.value === 'number') flat[k] = v.value;
        }
      }
      return flat;
    };
    const flat = normalize(answers);

    // Deep-matching #2: same certified shapes the stored scorer uses, so this
    // preview stays in lockstep with the feed. No-op until a shape is certified.
    const dimensionModels = await loadCertifiedModels();

    const scored = [];
    for (const c of candidates) {
      const otherFlat = normalize(c.answers);
      const result = calculateCompatibility(flat, otherFlat, { dimensionModels });
      if (result.isHardBlocked) continue;
      scored.push({
        userId:    c.user_id,
        firstName: c.first_name,
        lastInitial: (c.last_name || '').slice(0, 1).toUpperCase(),
        photoUrl:  c.photo_url,
        school:    c.school,
        score:     Math.round(result.finalPct),
      });
    }

    scored.sort((a, b) => b.score - a.score);
    res.json({ matches: scored.slice(0, 3) });
  } catch (err) {
    console.error('preview-matches failed:', err);
    res.status(500).json({ error: 'Failed to compute preview' });
  }
});

// ── POST /quiz/submit ─────────────────────────────────────────────────────
// Final submission — marks complete, triggers async match scoring
router.post('/submit', requireAuth, async (req, res) => {
  try {
    const { answers } = req.body || {};
    const err = validateAnswers(answers);
    if (err) return res.status(400).json({ error: err });

    // ── Additive merge + reassessment gate ────────────────────────────────
    // Progressive profiling: submissions are ADDITIVE. The 12-question core
    // unlocks matching; a user can come back later and add the optional ~20
    // to sharpen their matches. So we MERGE the new answers into whatever's
    // stored, and the 180-day reassessment cooldown only blocks a true
    // RE-TAKE — a completed profile being re-answered with NO net-new
    // questions, within the window. Adding questions (progressive completion)
    // is always allowed. First-time submitters sail through. (Each completed
    // submit triggers one Anthropic derivePersonality call, which is why pure
    // churn — re-answering the same set — stays rate-limited.)
    const REASSESS_COOLDOWN_DAYS = 180;
    const { rows: priorRows } = await pool.query(
      `SELECT answers, completed, updated_at FROM quiz_answers WHERE user_id = $1 LIMIT 1`,
      [req.user.id]
    );
    const existing = (priorRows[0] && priorRows[0].answers && typeof priorRows[0].answers === 'object')
      ? priorRows[0].answers
      : {};
    const existingCount = Object.keys(existing).length;
    const merged = { ...existing, ...answers };
    const addsNewQuestions = Object.keys(merged).length > existingCount;

    if (priorRows[0] && priorRows[0].completed && !addsNewQuestions) {
      const lastMs   = new Date(priorRows[0].updated_at).getTime();
      const elapsed  = Date.now() - lastMs;
      const cooldown = REASSESS_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
      if (elapsed < cooldown) {
        const daysLeft = Math.ceil((cooldown - elapsed) / (24 * 60 * 60 * 1000));
        return res.status(429).json({
          error: 'reassessment_cooldown',
          message: `You can re-take the compatibility quiz in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Re-assessments are limited to roughly twice a year so your match profile stays meaningful between cohorts.`,
          daysLeft,
          nextAvailable: new Date(lastMs + cooldown).toISOString(),
        });
      }
    }

    // Save the MERGED answers and mark completed (core answered = matchable).
    await pool.query(
      `INSERT INTO quiz_answers (user_id, answers, completed)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (user_id) DO UPDATE
       SET answers = $2, completed = TRUE, updated_at = NOW()`,
      [req.user.id, JSON.stringify(merged)]
    );

    // Mark user as quiz_completed
    await pool.query(
      'UPDATE users SET quiz_completed = TRUE WHERE id = $1',
      [req.user.id]
    );

    // Longitudinal snapshot — captures the user's profile + quiz state at
    // the moment of completion. Powers drift analysis when they re-take
    // the quiz months later. Best-effort: failures are logged, not fatal.
    pool.query(
      // user_profile_snapshot.user_id is TEXT in production (schema drift from
      // an older, richer design — verified via information_schema, see the note
      // in routes/admin.js), even though schema.sql/migrate_missing declare it
      // UUID. Writing u.id (a uuid) straight in throws "column is of type text
      // but expression is of type uuid", which — because this insert is
      // best-effort/.catch()'d — silently drops EVERY snapshot: the quiz
      // completes but nothing is ever captured, so GET /quiz/snapshots has no
      // history to return and the "profile over time" screen stays empty.
      // Cast the stored value to ::text (matching admin.js's working prod
      // pattern) and keep the uuid comparison in the WHERE against users.id.
      `INSERT INTO user_profile_snapshot (user_id, trigger, snapshot)
       SELECT u.id::text, 'quiz_complete', jsonb_build_object(
         -- Never persist secrets into the snapshot blob (it's shipped in the
         -- data export). Subtract every sensitive column, not just password_hash.
         'profile', to_jsonb(u)
                    - 'password_hash' - 'totp_secret' - 'totp_recovery_codes'
                    - 'stripe_customer_id' - 'tokens_valid_after'
                    - 'ban_reason' - 'parent_email',
         'answers', $2::jsonb
       )
       FROM users u WHERE u.id = $1::uuid`,
      [req.user.id, JSON.stringify(merged)],
    ).catch(err => console.error('snapshot insert failed:', err));

    // Trigger async match scoring (non-blocking). This first pass is
    // clinical-quiz only — the submitting user's personality profile isn't
    // derived yet. A second pass below re-scores with the 60/40 MBTI/DISC/
    // OCEAN blend folded in once the profile exists.
    scoreNewMatches(req.user.id, merged).catch(err =>
      console.error('Async scoring error:', err)
    );

    // Derive a personality profile from the answers — one Anthropic call per
    // submit. Non-blocking + best-effort: derivePersonality() never rejects
    // (it falls back to a deterministic profile), and a DB failure here is
    // logged, not fatal. The /submit response is sent without waiting.
    derivePersonality(merged, [], '', req.user.id)
      .then(profile => pool.query(
        `INSERT INTO personality_profiles
           (user_id, archetype, ocean, summary, strengths, growth_areas, roommate_fit, model, source, mbti, disc)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (user_id) DO UPDATE
         SET archetype = $2, ocean = $3, summary = $4, strengths = $5,
             growth_areas = $6, roommate_fit = $7, model = $8, source = $9,
             mbti = $10, disc = $11, updated_at = NOW()`,
        [
          req.user.id,
          profile.archetype,
          JSON.stringify(profile.ocean),
          profile.summary,
          JSON.stringify(profile.strengths),
          JSON.stringify(profile.growth_areas),
          profile.roommate_fit,
          profile.model,
          profile.source,
          profile.mbti,
          profile.disc,
        ],
      ).catch(err => console.error('personality store failed:', err.message)))
      .then(() => scoreNewMatches(req.user.id, merged))
      .catch(err => console.error('post-submit re-score failed:', err.message));

    res.json({ success: true, message: 'Quiz submitted. Calculating your matches...' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit quiz' });
  }
});

// ── Async: score against all other completed users ────────────────────────
async function scoreNewMatches(userId, newAnswers) {
  // Get school + the submitting user's dealbreakers (their "what matters
  // most" picks from profile setup). These get UNIONED with each candidate's
  // dealbreakers and passed into calculateCompatibility so flagged
  // categories carry amplified weight in the pair's score.
  const { rows: userRow } = await pool.query(
    'SELECT school, dealbreakers, validation_score, move_in_timeline FROM users WHERE id = $1',
    [userId]
  );
  if (!userRow[0]) return;
  const myDealbreakers = Array.isArray(userRow[0].dealbreakers) ? userRow[0].dealbreakers : [];
  const myValidation   = userRow[0].validation_score != null ? Number(userRow[0].validation_score) : undefined;

  // Deep-matching #2: load the gate-certified per-dimension shapes once. Empty
  // until real outcomes certify a shape → scoring stays on today's curve.
  const dimensionModels = await loadCertifiedModels();

  // Pull each candidate's quiz answers AND their dealbreakers in the same
  // query — saves an N+1 round-trip we'd otherwise pay on the per-user loop.
  const { rows: otherUsers } = await pool.query(
    `SELECT qa.user_id, qa.answers, u.dealbreakers, u.validation_score
     FROM quiz_answers qa
     JOIN users u ON u.id = qa.user_id
     WHERE qa.completed = TRUE
       AND qa.user_id != $1
       AND u.is_paused = FALSE`,
    [userId]
  );

  // Deep-matching #6: load the latest pulse_drift for the submitter + every
  // candidate once, and resolve the projection horizon from the submitter's
  // move-in timeline (else a fixed 90 days). Empty drift ⇒ projection/convergence
  // are no-ops ⇒ scoring stays exactly today.
  const driftMap = await loadDrift([userId, ...otherUsers.map(o => o.user_id)]);
  const myDrift = driftMap[String(userId)] || {};
  const horizonDays = horizonFromMoveIn(userRow[0].move_in_timeline);

  // Deep-matching #5: certified LLM text-insight shapes + the consenting users'
  // derived construct vectors. Empty until a construct certifies / users opt in
  // → llmDelta 0 → scoring unchanged, bit-for-bit.
  const llmModels = await textInsight.loadCertifiedModels();
  const llmFeatures = await textInsight.loadFeatures([userId, ...otherUsers.map(o => o.user_id)]);
  const myLlm = llmFeatures[String(userId)] || {};

  // v8: the abstract MBTI/DISC/OCEAN personality blend was removed from matching,
  // so the personality_profiles fetch (incl. a per-submit full-table scan) that
  // used to live here is gone. Behavioral validation_score (above) is the only
  // per-user signal the scorer now folds in (step-4 multiplier).

  // Build all the score rows in one pass, then bulk-INSERT in a single
  // round-trip. Previously this fired one INSERT per other user — at 100
  // students the 100th signup serialized 99 round-trips through the
  // connection pool. Batching collapses that to a single statement.
  const rows = [];
  for (const other of otherUsers) {
    // Union both users' dealbreaker tags — either side flagging cleanliness
    // (etc.) amplifies that question's weight in the pair's score.
    const theirDealbreakers = Array.isArray(other.dealbreakers) ? other.dealbreakers : [];
    const combinedDealbreakers = [...new Set([...myDealbreakers, ...theirDealbreakers])];
    const result = calculateCompatibility(newAnswers, other.answers, {
      dealbreakers: combinedDealbreakers,
      validationA:  myValidation,
      validationB:  other.validation_score != null ? Number(other.validation_score) : undefined,
      dimensionModels,
      driftA:       myDrift,
      driftB:       driftMap[String(other.user_id)] || {},
      horizonDays,
      llmModels,
      llmFeaturesA: myLlm,
      llmFeaturesB: llmFeatures[String(other.user_id)] || {},
    });

    // NOTE: hard-blocked pairs are NO LONGER skipped. We used to `continue`
    // here, which wrote no row at all — making a genuine incompatibility
    // (e.g. never-smoker vs smokes-at-home-daily) indistinguishable from a
    // bug ("why didn't they match?"). We now WRITE the row with score 0 and
    // is_hard_blocked = TRUE, so the pair is visible in the data / founder
    // dashboard, and a later answer change flips it correctly via the
    // ON CONFLICT upsert below. The feed filters score >= 50 (and
    // is_hard_blocked = FALSE), so students still never see these pairs.

    // v8 (2026-06-24) — LIFESTYLE-FIRST: the abstract MBTI/DISC/OCEAN
    // personality blend (formerly 30% of the score) has been REMOVED. The
    // stored compatibility score is now exactly the scoring-engine result —
    // daily-living friction + behavioral-conflict scenarios + money, with
    // dealbreaker caps. Personality profiles are still derived for the in-app
    // readout; they just no longer fold into matching. (computePersonalityMatch
    // / calibratePersonality are intentionally left unused here.)
    const finalPct = result.finalPct;

    const [userA, userB] = userId < other.user_id
      ? [userId, other.user_id]
      : [other.user_id, userId];
    rows.push([
      userA, userB,
      finalPct,
      result.isHardBlocked,
      result.isSoftBlocked,
      result.shadowPenalty,
      JSON.stringify(result.breakdown),
      generateWhyMatched(result.breakdown, finalPct, result.complementaryDims, result.convergingDims, result.textInsightDims,
        { capReason: result.capReason, confidence: result.confidence, frictionTopic: topFrictionTopic(newAnswers, other.answers) }),
      // Part 2: behavioral-validation layer. validationMultiplier is an honest
      // 1.0 unless BOTH users have a real validation_score; preValidationPct is
      // the headline before that multiplier.
      result.preValidationPct,
      result.validationMultiplier,
      // Deep-matching #2: structured complementarity so the app can lead with
      // the "balance" phrasing. Empty array unless a shape is certified.
      JSON.stringify(result.complementaryDims || []),
      // Deep-matching #6: structured trajectory ("converging") dims. Empty unless
      // projection/convergence is earned and materially closing this pair.
      JSON.stringify(result.convergingDims || []),
      // Confidence coefficient (<1 when either side's answers are thin/uniform).
      // Stored so the feed can render a low-confidence score as "still learning"
      // rather than a hard number that looks as certain as a full-data one.
      result.confidence,
      // Stress dimension (spec §4). NULL unless BOTH answered the stress items,
      // i.e. NULL for every pair until the app flips STRESS_IDS into SCORED_IDS.
      // The headline stored here is the DETERMINISTIC per-pattern sentence: this
      // path scores every candidate pair on quiz submit, so a Claude call here
      // would be one API call per pair. The pair-specific narrative is generated
      // lazily on the match-detail surface (where /explain already does cached
      // per-pair Claude work) and overwrites this. Storing the fallback keeps
      // §4's `headline: string` contract satisfied from the first write.
      result.underPressure
        ? JSON.stringify({ ...result.underPressure, headline: fallbackHeadline(result.underPressure.pattern) })
        : null,
    ]);
  }

  if (rows.length === 0) return;

  // Flatten into a single $1...$N param list. 14 columns per row.
  const COLS = 14;
  const valuePlaceholders = rows
    .map((_, rowIdx) => {
      const base = rowIdx * COLS;
      const ph = Array.from({ length: COLS }, (_, i) => `$${base + i + 1}`).join(', ');
      return `(${ph})`;
    })
    .join(', ');
  const params = rows.flat();

  await pool.query(
    `INSERT INTO compatibility_scores
       (user_a, user_b, score, is_hard_blocked, is_soft_blocked, shadow_penalty, breakdown, why_matched, pre_validation_pct, validation_multiplier, complementary_dims, converging_dims, confidence, under_pressure)
     VALUES ${valuePlaceholders}
     ON CONFLICT (user_a, user_b) DO UPDATE
     SET score          = EXCLUDED.score,
         is_hard_blocked = EXCLUDED.is_hard_blocked,
         is_soft_blocked = EXCLUDED.is_soft_blocked,
         shadow_penalty  = EXCLUDED.shadow_penalty,
         breakdown       = EXCLUDED.breakdown,
         why_matched     = EXCLUDED.why_matched,
         pre_validation_pct    = EXCLUDED.pre_validation_pct,
         validation_multiplier = EXCLUDED.validation_multiplier,
         complementary_dims    = EXCLUDED.complementary_dims,
         converging_dims       = EXCLUDED.converging_dims,
         under_pressure        = EXCLUDED.under_pressure,
         confidence      = EXCLUDED.confidence,
         calculated_at   = NOW()`,
    params,
  );

  // Fire match_created on BOTH users' timelines. The compatibility row
  // captures a pair, but being matched is an event for each side — they
  // should each see "match created" in their own PostHog history.
  // rows are [userA, userB, score, ...] tuples — pull from the same array
  // we just inserted so the analytics line up exactly with what landed
  // in the DB.
  const tierFor = (pct) => {
    if (pct >= 90) return 'soulmate';
    if (pct >= 80) return 'high';
    if (pct >= 70) return 'good';
    if (pct >= 65) return 'surface';
    return 'low';
  };
  for (const r of rows) {
    const [a, b, score] = r;
    const tier = tierFor(score);
    analytics.track(analytics.EVENTS.match_created, a, { other_user_id: b, score, tier });
    analytics.track(analytics.EVENTS.match_created, b, { other_user_id: a, score, tier });
  }
}

// ── Recompute every pair from scratch ─────────────────────────────────────
// Re-runs scoreNewMatches for every completed, non-banned user, regenerating
// all compatibility_scores rows (idempotent upserts via the ON CONFLICT in
// scoreNewMatches). This repairs the failure mode where a user finished the
// quiz before anyone else existed and never got re-scored — their feed stays
// empty even though their answers are fine and they SHOULD match. Paused
// users are still scored as the *submitter* (so they can see others) but
// remain excluded as candidates by scoreNewMatches' own query, matching live
// behavior. Returns a small summary for the admin tool. Best-effort per user:
// one user's failure doesn't abort the whole sweep.
async function recomputeAllMatches() {
  const { rows: users } = await pool.query(
    `SELECT qa.user_id, qa.answers
       FROM quiz_answers qa
       JOIN users u ON u.id = qa.user_id
      WHERE qa.completed = TRUE
        AND COALESCE(u.is_banned, FALSE) = FALSE
      ORDER BY qa.updated_at ASC`,
  );
  let processed = 0;
  let failed = 0;
  for (const u of users) {
    try {
      await scoreNewMatches(u.user_id, u.answers);
      processed++;
    } catch (err) {
      failed++;
      console.error(`[recompute] scoring failed for ${u.user_id}:`, err.message);
    }
  }
  return { completedUsers: users.length, processed, failed };
}

// ── Self-heal: re-derive personalities that failed to persist ──────────────
// derivePersonality() is best-effort and never rejects, but a transient DB
// write failure (or a crash between the Anthropic call and the INSERT) can
// leave a completed-quiz user with NO personality_profiles row. Those users
// then get clinical-ONLY scores — no 60/40 MBTI/DISC/OCEAN blend — quietly
// degraded until something repairs them. scoreNewMatches logs each such gap to
// Sentry; this closes the loop by actually healing it: find the missing rows,
// re-derive (BOUNDED per run so a backlog can't spike Anthropic cost), then
// re-score the healed users so their feed reflects the full blend.
//
// Only NULL rows are healed — a 'fallback' (deterministic) profile is already
// a valid blendable profile, not a gap, so we don't burn a call re-deriving it.
// Best-effort per user; one failure never aborts the sweep. Driven by a
// low-frequency interval (server.js) AND a bot-token endpoint (botAdmin) so a
// cron can also trigger it. Idempotent — a healed user drops out of the query.
async function healMissingPersonalities({ limit = 25 } = {}) {
  const { rows: gaps } = await pool.query(
    `SELECT qa.user_id, qa.answers
       FROM quiz_answers qa
       JOIN users u ON u.id = qa.user_id
       LEFT JOIN personality_profiles pp ON pp.user_id = qa.user_id
      WHERE qa.completed = TRUE
        AND COALESCE(u.is_banned, FALSE) = FALSE
        AND pp.user_id IS NULL
      ORDER BY qa.updated_at ASC
      LIMIT $1`,
    [limit],
  );
  let healed = 0, rescored = 0, failed = 0;
  for (const g of gaps) {
    try {
      await rederivePersonalityFor(g.user_id);   // writes the missing profile
      healed++;
      try {
        await scoreNewMatches(g.user_id, g.answers); // blend now applies
        rescored++;
      } catch (err) {
        console.error(`[heal] rescore failed for ${g.user_id}:`, err.message);
      }
    } catch (err) {
      failed++;
      console.error(`[heal] re-derive failed for ${g.user_id}:`, err.message);
    }
  }
  return { missing: gaps.length, healed, rescored, failed };
}

// ── DELETE /quiz/reset ─────────────────────────────────────────────────────
// Clears the user's quiz_answers row + quiz_completed flag so they can
// retake. Snapshots are intentionally preserved — they're the longitudinal
// record we use to compute drift across retakes.
router.delete('/reset', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM quiz_answers WHERE user_id = $1', [req.user.id]);
    await pool.query('UPDATE users SET quiz_completed = FALSE WHERE id = $1', [req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('quiz reset failed:', err);
    res.status(500).json({ error: 'Failed to reset quiz' });
  }
});

// ── GET /quiz/snapshots ────────────────────────────────────────────────────
// Returns a chronological list of every quiz completion the user has
// ever made, along with computed drift vs. the previous snapshot:
//   - changedAnswers: count of question IDs where the answer differs
//   - topDriftCategories: 1-3 categories with the largest movement
//   - driftPct: 0..100 — share of answered questions that changed
//
// The first snapshot has all drift fields null. The category map here
// derives from the canonical CATEGORIES constant in services/scoring.js
// so we can't drift out of sync. Previously this used contiguous id
// ranges (1..5 = attachment, 6..10 = emotional, etc.) that DIDN'T
// match the actual question ids — Q22 lives under attachment in
// scoring.js but the snapshot map put it under identity. Result:
// snapshot drift reports were labeled against the wrong buckets,
// making profile-drift trends meaningless. Now we import the real
// map.
const { CATEGORIES: CANONICAL_CATEGORIES } = require('../services/scoring');
const SNAPSHOT_CATEGORIES = Object.fromEntries(
  Object.entries(CANONICAL_CATEGORIES).map(([cat, { ids }]) => [cat, ids]),
);

function flatAnswerValue(raw) {
  if (typeof raw === 'number') return raw;
  if (raw && typeof raw === 'object') {
    if (typeof raw.index === 'number') return raw.index;
    if (typeof raw.value === 'number') return raw.value;
  }
  return null;
}

// A snapshot's `snapshot` column is JSONB and normally arrives already parsed
// into an object, but be tolerant of it coming back as a JSON string (double
// encoding) or NULL (a legacy/partial row). Always hand computeDrift a plain
// object of answers so it can never throw on a shape it didn't expect.
function snapshotAnswers(snapshot) {
  let s = snapshot;
  if (typeof s === 'string') {
    try { s = JSON.parse(s); } catch { return {}; }
  }
  const answers = s && typeof s === 'object' ? s.answers : null;
  return answers && typeof answers === 'object' ? answers : {};
}

function computeDrift(prev, curr) {
  const p = prev && typeof prev === 'object' ? prev : {};
  const c = curr && typeof curr === 'object' ? curr : {};
  const allIds = new Set([...Object.keys(p), ...Object.keys(c)]);
  let changed = 0, considered = 0;
  const categoryMoves = {};
  for (const id of allIds) {
    const a = flatAnswerValue(p[id]);
    const b = flatAnswerValue(c[id]);
    if (a == null || b == null) continue;
    considered += 1;
    if (a !== b) {
      changed += 1;
      const cat = Object.entries(SNAPSHOT_CATEGORIES)
        .find(([, ids]) => ids.includes(Number(id)))?.[0];
      if (cat) categoryMoves[cat] = (categoryMoves[cat] || 0) + 1;
    }
  }
  const topDriftCategories = Object.entries(categoryMoves)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([cat, n]) => ({ category: cat, changes: n }));
  return {
    changedAnswers: changed,
    driftPct: considered ? Math.round((changed / considered) * 100) : 0,
    topDriftCategories,
  };
}

router.get('/snapshots', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, trigger, snapshot, created_at
       FROM user_profile_snapshot
       WHERE user_id = $1 AND trigger = 'quiz_complete'
       ORDER BY created_at ASC`,
      [req.user.id]
    );

    const out = [];
    let prevAnswers = null;
    for (const r of rows) {
      const answers = snapshotAnswers(r.snapshot);
      // The earliest snapshot has no predecessor, so its drift is always null.
      // Never let a single malformed row 500 the whole history — the frontend
      // treats any error status as "couldn't load," so degrade that row's
      // drift to null and keep serving the rest.
      let drift = null;
      if (prevAnswers) {
        try { drift = computeDrift(prevAnswers, answers); }
        catch (e) { console.error('snapshot drift compute failed:', e); }
      }
      out.push({
        id:         String(r.id),
        createdAt:  r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        // Don't ship the full answer payload to the client — only the
        // derived signals. Keeps the wire size small and avoids leaking
        // any text-answer free-form content unintentionally.
        drift,
      });
      prevAnswers = answers;
    }

    // Newest-first for UI display
    out.reverse();
    res.json({ snapshots: out });
  } catch (err) {
    console.error('snapshots fetch failed:', err);
    res.status(500).json({ error: 'Failed to load quiz history' });
  }
});

// ── GET /quiz/personality ─────────────────────────────────────────────────
// Returns the user's AI-derived personality profile (Big Five / OCEAN +
// archetype + narrative). Produced once at quiz submission by
// services/personality.js. Returns { profile: null } if the user hasn't
// completed the quiz yet, or the derivation hasn't finished writing.
router.get('/personality', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT archetype, mbti, disc, ocean, summary, strengths, growth_areas,
              roommate_fit, source, updated_at
       FROM personality_profiles
       WHERE user_id = $1`,
      [req.user.id],
    );
    if (!rows[0]) return res.json({ profile: null });

    const r = rows[0];
    res.json({
      profile: {
        archetype:   r.archetype,
        mbti:        r.mbti,
        disc:        r.disc,
        ocean:       r.ocean,
        summary:     r.summary,
        strengths:   r.strengths || [],
        growthAreas: r.growth_areas || [],
        roommateFit: r.roommate_fit,
        source:      r.source,
        updatedAt:   r.updated_at,
      },
    });
  } catch (err) {
    console.error('personality fetch failed:', err);
    res.status(500).json({ error: 'Failed to load personality profile' });
  }
});

// ── POST /quiz/voice/tts ──────────────────────────────────────────────────
// Text -> spoken audio (mp3). The voice-interview screen calls this to play
// each question aloud.
router.post('/voice/tts', requireAuth, async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim().slice(0, 800);
    if (!text) return res.status(400).json({ error: 'text is required' });
    const audio = await textToSpeech(text);
    res.set('Content-Type', 'audio/mpeg');
    res.send(audio);
  } catch (err) {
    console.error('[voice/tts] failed:', err.message);
    res.status(502).json({ error: 'Voice playback is unavailable right now.' });
  }
});

// ── POST /quiz/voice/transcribe ──────────────────────────────────────────
// Multipart audio answer -> { text }. The voice-interview screen uploads the
// student's recorded answer here and gets back the transcript.
router.post('/voice/transcribe', requireAuth, voiceAudioUpload, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'audio file is required' });
    const filename = req.file.originalname || 'answer.webm';
    // Transcript (required) + vocal-emotion analysis (best-effort) in
    // parallel. analyzeVoiceEmotion() returns null when HUME_API_KEY is
    // unset or the call fails, so the interview always works on the
    // transcript alone.
    const [transcription, emotions] = await Promise.all([
      transcribe(req.file.buffer, filename),
      analyzeVoiceEmotion(req.file.buffer, filename),
    ]);
    res.json({ text: transcription.text, emotions: emotions || null });
  } catch (err) {
    console.error('[voice/transcribe] failed:', err.message);
    res.status(502).json({ error: 'Transcription is unavailable right now.' });
  }
});

// ── Personality re-derivation helper ─────────────────────────────────────
// Re-derive and persist a user's AI personality profile from everything we
// have on them — quiz answers + optional voice transcripts + optional
// writing sample. Shared by /quiz/voice/submit and /quiz/writing so a
// student who adds both gets a profile reflecting all of it. Best-effort:
// derivePersonality() never rejects; callers run this fire-and-forget.
async function rederivePersonalityFor(userId) {
  const { rows } = await pool.query(
    'SELECT answers, voice_answers, writing_sample FROM quiz_answers WHERE user_id = $1',
    [userId],
  );
  if (!rows[0]) return;
  const profile = await derivePersonality(
    rows[0].answers || {},
    rows[0].voice_answers || [],
    rows[0].writing_sample || '',
    userId,
  );
  await pool.query(
    `INSERT INTO personality_profiles
       (user_id, archetype, ocean, summary, strengths, growth_areas, roommate_fit, model, source, mbti, disc)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (user_id) DO UPDATE
     SET archetype = $2, ocean = $3, summary = $4, strengths = $5,
         growth_areas = $6, roommate_fit = $7, model = $8, source = $9,
         mbti = $10, disc = $11, updated_at = NOW()`,
    [
      userId,
      profile.archetype,
      JSON.stringify(profile.ocean),
      profile.summary,
      JSON.stringify(profile.strengths),
      JSON.stringify(profile.growth_areas),
      profile.roommate_fit,
      profile.model,
      profile.source,
      profile.mbti,
      profile.disc,
    ],
  );
}

// ── POST /quiz/voice/submit ──────────────────────────────────────────────
// Final step of the voice interview. Stores the student's spoken-answer
// transcripts on their quiz_answers row and re-derives their AI personality
// profile with the voice answers folded in as richer signal.
//
// Best-effort enrichment: the quiz-only profile already exists from
// /quiz/submit — this just deepens it. The re-derivation runs async (one
// Anthropic call, same pattern as /quiz/submit) so the response returns
// immediately and the Mirror screen picks up the richer profile on its
// next fetch.
const MAX_VOICE_ANSWERS      = 10;
const MAX_VOICE_QUESTION_LEN = 500;
const MAX_VOICE_TEXT_LEN     = 5000;

router.post('/voice/submit', requireAuth, async (req, res) => {
  try {
    const raw = Array.isArray(req.body && req.body.answers) ? req.body.answers : null;
    if (!raw) return res.status(400).json({ error: 'answers array required' });
    if (raw.length > MAX_VOICE_ANSWERS) {
      return res.status(400).json({ error: 'too many voice answers' });
    }

    // Normalize + cap each entry; drop anything without a real transcript.
    const voiceAnswers = [];
    for (const a of raw) {
      if (!a || typeof a !== 'object') continue;
      const question   = String(a.question   || '').trim().slice(0, MAX_VOICE_QUESTION_LEN);
      const transcript = String(a.transcript || '').trim().slice(0, MAX_VOICE_TEXT_LEN);
      if (!transcript) continue;
      // Optional vocal-emotion labels (Hume) — a short list of strings.
      const emotions = Array.isArray(a.emotions)
        ? a.emotions.filter(e => typeof e === 'string').slice(0, 8).map(e => e.slice(0, 40))
        : [];
      voiceAnswers.push(
        emotions.length ? { question, transcript, emotions } : { question, transcript },
      );
    }
    if (voiceAnswers.length === 0) {
      return res.status(400).json({ error: 'no usable voice answers' });
    }

    // Persist alongside the quiz answers. The voice interview happens after
    // the quiz, so a quiz_answers row should already exist — a 0-row UPDATE
    // means the student skipped the quiz, which we surface clearly.
    const { rowCount } = await pool.query(
      `UPDATE quiz_answers SET voice_answers = $2, updated_at = NOW()
       WHERE user_id = $1`,
      [req.user.id, JSON.stringify(voiceAnswers)],
    );
    if (rowCount === 0) {
      return res.status(409).json({
        error: 'Finish the compatibility quiz before recording the voice interview.',
      });
    }

    // Re-derive the personality profile with quiz + voice (+ any writing
    // sample) signal combined. Async + best-effort, mirroring /quiz/submit —
    // the response returns immediately and the Mirror screen picks up the
    // richer profile on its next fetch.
    rederivePersonalityFor(req.user.id)
      .catch(err => console.error('[voice/submit] re-derive failed:', err.message));

    res.json({ success: true });
  } catch (err) {
    console.error('[voice/submit] failed:', err.message);
    res.status(500).json({ error: 'Failed to save voice interview' });
  }
});

// ── POST /quiz/writing ───────────────────────────────────────────────────
// Optional orthogonal input — the student volunteers a free-text writing
// sample (an essay, paper, or personal statement). Stored on their
// quiz_answers row and folded into the AI personality profile as extra
// signal, exactly like the voice interview.
const MAX_WRITING_CHARS = 6000;

router.post('/writing', requireAuth, async (req, res) => {
  try {
    const sample = String((req.body && req.body.writingSample) || '').trim();
    if (!sample) return res.status(400).json({ error: 'writingSample is required' });
    if (sample.length > MAX_WRITING_CHARS) {
      return res.status(400).json({ error: `Keep your writing sample under ${MAX_WRITING_CHARS} characters.` });
    }

    // The writing sample is optional and added after the quiz, so a
    // quiz_answers row should already exist — a 0-row UPDATE means the
    // student skipped the quiz.
    const { rowCount } = await pool.query(
      `UPDATE quiz_answers SET writing_sample = $2, updated_at = NOW()
       WHERE user_id = $1`,
      [req.user.id, sample],
    );
    if (rowCount === 0) {
      return res.status(409).json({
        error: 'Finish the compatibility quiz before adding a writing sample.',
      });
    }

    // Re-derive the profile with the writing sample folded in. Async +
    // best-effort, same pattern as /quiz/voice/submit.
    rederivePersonalityFor(req.user.id)
      .catch(err => console.error('[quiz/writing] re-derive failed:', err.message));

    res.json({ success: true });
  } catch (err) {
    console.error('[quiz/writing] failed:', err.message);
    res.status(500).json({ error: 'Failed to save writing sample' });
  }
});

module.exports = router;
// Exposed for the bot-admin recompute tool (regenerates missing/stale
// compatibility_scores). Attaching to the router export avoids moving the
// live scoring code into a separate module.
module.exports.scoreNewMatches    = scoreNewMatches;
module.exports.recomputeAllMatches = recomputeAllMatches;
module.exports.healMissingPersonalities = healMissingPersonalities;
