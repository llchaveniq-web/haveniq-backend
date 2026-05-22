const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { calculateCompatibility, generateWhyMatched } = require('../services/scoring');
const { derivePersonality } = require('../services/personality');
const { textToSpeech, transcribe } = require('../services/voice');
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
const MAX_QUESTION_ID  = 100;   // Wider than the current 55-question set
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
router.post('/preview-matches', requireAuth, async (req, res) => {
  try {
    const { answers } = req.body || {};
    const err = validateAnswers(answers);
    if (err) return res.status(400).json({ error: err });

    // Need at least a handful of answers for the score to mean anything —
    // otherwise the top result is just whoever happens to be in the DB.
    const answerCount = Object.keys(answers || {}).length;
    if (answerCount < 5) return res.json({ matches: [] });

    // Pull completed users at the same school. Filter demo accounts unless
    // the caller is a founder (matches the rest of the app's behavior).
    const { isFounder } = require('../utils/founders');
    const includeDemos = isFounder(req.user.id);
    const demoFilter = includeDemos ? '' : `AND u.email NOT LIKE '%@haveniq-demo.edu'`;

    const { rows: candidates } = await pool.query(
      `SELECT qa.user_id, qa.answers, u.first_name, u.last_name, u.photo_url, u.school
       FROM quiz_answers qa
       JOIN users u ON u.id = qa.user_id
       WHERE qa.completed = TRUE
         AND qa.user_id != $1
         AND u.is_paused = FALSE
         ${demoFilter}`,
      [req.user.id]
    );

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

    const scored = [];
    for (const c of candidates) {
      const otherFlat = normalize(c.answers);
      const result = calculateCompatibility(flat, otherFlat);
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

    // Save final answers and mark completed
    await pool.query(
      `INSERT INTO quiz_answers (user_id, answers, completed)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (user_id) DO UPDATE
       SET answers = $2, completed = TRUE, updated_at = NOW()`,
      [req.user.id, JSON.stringify(answers)]
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
      // $1 is cast to ::uuid — a bare $1 in the SELECT list deduces as text
      // and clashes with the uuid comparison in the WHERE, which Postgres
      // rejects ("inconsistent types deduced for parameter $1").
      `INSERT INTO user_profile_snapshot (user_id, trigger, snapshot)
       SELECT $1::uuid, 'quiz_complete', jsonb_build_object(
         'profile', to_jsonb(u) - 'password_hash',
         'answers', $2::jsonb
       )
       FROM users u WHERE u.id = $1`,
      [req.user.id, JSON.stringify(answers)],
    ).catch(err => console.error('snapshot insert failed:', err));

    // Trigger async match scoring (non-blocking)
    scoreNewMatches(req.user.id, answers).catch(err =>
      console.error('Async scoring error:', err)
    );

    // Derive a personality profile from the answers — one Anthropic call per
    // submit. Non-blocking + best-effort: derivePersonality() never rejects
    // (it falls back to a deterministic profile), and a DB failure here is
    // logged, not fatal. The /submit response is sent without waiting.
    derivePersonality(answers)
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
      ))
      .catch(err => console.error('personality store failed:', err.message));

    res.json({ success: true, message: 'Quiz submitted. Calculating your matches...' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit quiz' });
  }
});

// ── Async: score against all other completed users ────────────────────────
async function scoreNewMatches(userId, newAnswers) {
  // Get all other users who completed the quiz, same school
  const { rows: userRow } = await pool.query(
    'SELECT school FROM users WHERE id = $1',
    [userId]
  );
  if (!userRow[0]) return;

  const { rows: otherUsers } = await pool.query(
    `SELECT qa.user_id, qa.answers
     FROM quiz_answers qa
     JOIN users u ON u.id = qa.user_id
     WHERE qa.completed = TRUE
       AND qa.user_id != $1
       AND u.is_paused = FALSE`,
    [userId]
  );

  // Build all the score rows in one pass, then bulk-INSERT in a single
  // round-trip. Previously this fired one INSERT per other user — at 100
  // students the 100th signup serialized 99 round-trips through the
  // connection pool. Batching collapses that to a single statement.
  const rows = [];
  for (const other of otherUsers) {
    const result = calculateCompatibility(newAnswers, other.answers);
    if (result.isHardBlocked) continue;
    const [userA, userB] = userId < other.user_id
      ? [userId, other.user_id]
      : [other.user_id, userId];
    rows.push([
      userA, userB,
      result.finalPct,
      result.isHardBlocked,
      result.isSoftBlocked,
      result.shadowPenalty,
      JSON.stringify(result.breakdown),
      generateWhyMatched(result.breakdown, result.finalPct),
    ]);
  }

  if (rows.length === 0) return;

  // Flatten into a single $1...$N param list. 8 columns per row.
  const COLS = 8;
  const valuePlaceholders = rows
    .map((_, rowIdx) => {
      const base = rowIdx * COLS;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
    })
    .join(', ');
  const params = rows.flat();

  await pool.query(
    `INSERT INTO compatibility_scores
       (user_a, user_b, score, is_hard_blocked, is_soft_blocked, shadow_penalty, breakdown, why_matched)
     VALUES ${valuePlaceholders}
     ON CONFLICT (user_a, user_b) DO UPDATE
     SET score          = EXCLUDED.score,
         is_hard_blocked = EXCLUDED.is_hard_blocked,
         is_soft_blocked = EXCLUDED.is_soft_blocked,
         shadow_penalty  = EXCLUDED.shadow_penalty,
         breakdown       = EXCLUDED.breakdown,
         why_matched     = EXCLUDED.why_matched,
         calculated_at   = NOW()`,
    params,
  );
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
// The first snapshot has all drift fields null. The category mapping
// here mirrors services/scoring.js — kept in sync manually because
// duplicating the constant is cheaper than refactoring the import for a
// single read-side feature.
const SNAPSHOT_CATEGORIES = {
  attachment:    [1,2,3,4,5],
  emotional:     [6,7,8,9,10],
  control:       [11,12,13,14,15],
  communication: [16,17,18,19,20],
  identity:      [21,22,23,24,25],
  childhood:     [26,27,28,29,30],
  shadow:        [31,32,33,34,35],
  nervous:       [36,37,38,39,40],
  selfawareness: [41,42,43,44,45,46,47],
  lifestyle:     [48,49,50,51,52,53,54,55],
};

function flatAnswerValue(raw) {
  if (typeof raw === 'number') return raw;
  if (raw && typeof raw === 'object') {
    if (typeof raw.index === 'number') return raw.index;
    if (typeof raw.value === 'number') return raw.value;
  }
  return null;
}

function computeDrift(prev, curr) {
  const allIds = new Set([...Object.keys(prev || {}), ...Object.keys(curr || {})]);
  let changed = 0, considered = 0;
  const categoryMoves = {};
  for (const id of allIds) {
    const a = flatAnswerValue(prev[id]);
    const b = flatAnswerValue(curr[id]);
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
      const answers = r.snapshot?.answers ?? {};
      const drift = prevAnswers ? computeDrift(prevAnswers, answers) : null;
      out.push({
        id:         r.id,
        createdAt:  r.created_at,
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
    const { text } = await transcribe(req.file.buffer, req.file.originalname || 'answer.webm');
    res.json({ text });
  } catch (err) {
    console.error('[voice/transcribe] failed:', err.message);
    res.status(502).json({ error: 'Transcription is unavailable right now.' });
  }
});

module.exports = router;
