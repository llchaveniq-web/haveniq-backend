/**
 * Daily Discovery — one new thing each day, alternating
 * bonus question → self-reflection → bonus question → ...
 *
 * Engagement loop without the streak-anxiety of Duolingo. The
 * content is genuinely useful (questions add training signal,
 * reflections deliver insight users earned via the quiz). No
 * gamified pressure, no "you'll lose your streak" emails.
 *
 * Determinism: once we pick today's content for a user, it stays
 * pinned for the day via UNIQUE(user_id, shown_date) — so opening
 * the app at 9am, noon, and 9pm all show the same content.
 *
 * Content selection:
 *   - Even day-counts → reflection
 *   - Odd day-counts  → bonus question
 *   Day count = COUNT(shown_date) for this user.
 *
 * Questions: picked from the BONUS_QUESTIONS pool, skipping any
 * the user has already seen. Once the pool is exhausted we loop.
 *
 * Reflections: picked from REFLECTIONS pool, filtered to templates
 * whose `requires` are met by the user's profile, then by `matches`,
 * then we skip ones already shown. Falls back to the always-true
 * 'general-quiet-recovery' template if nothing personalized fits.
 */

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { BONUS_QUESTIONS, REFLECTIONS } = require('../data/dailyDiscoveryPool');

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_discovery (
      id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      shown_date    DATE NOT NULL,
      content_type  TEXT NOT NULL,            -- 'question' or 'reflection'
      content_id    TEXT NOT NULL,            -- question.id or reflection.id
      answered      BOOLEAN DEFAULT FALSE,
      answer_value  JSONB,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      answered_at   TIMESTAMPTZ,
      UNIQUE(user_id, shown_date)
    );
    CREATE INDEX IF NOT EXISTS idx_dd_user_date
      ON daily_discovery(user_id, shown_date DESC);
  `).catch((e) => console.error('[daily_discovery] ensure table:', e.message));
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build the user's profile data needed for reflection matching.
 * Best-effort: any field that fails to load comes back undefined,
 * and reflection templates that require it just don't match.
 */
async function buildUserProfile(userId) {
  const profile = { firstName: null };
  try {
    const { rows } = await pool.query(
      'SELECT first_name FROM users WHERE id = $1', [userId],
    );
    if (rows[0]) profile.firstName = rows[0].first_name;
  } catch {}

  try {
    const { rows } = await pool.query(
      'SELECT attachment_style, com_style, big_five FROM personality_profiles WHERE user_id = $1',
      [userId],
    );
    if (rows[0]) {
      profile.attachmentStyle = rows[0].attachment_style;
      profile.comStyle        = rows[0].com_style;
      const bf = rows[0].big_five || {};
      profile.extraversionScore       = bf.extraversion;
      profile.conscientiousnessScore  = bf.conscientiousness;
      profile.agreeablenessScore      = bf.agreeableness;
      profile.honestyHumilityScore    = bf.honesty_humility;
      profile.executiveFunction       = bf.executive_function ?? bf.conscientiousness;
      profile.nervousReactivity       = bf.nervous_reactivity;
    }
  } catch {}

  return profile;
}

async function pickContent(userId) {
  // Count prior days to decide question vs reflection
  const { rows: countRows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM daily_discovery WHERE user_id = $1',
    [userId],
  );
  const dayCount = countRows[0]?.n ?? 0;
  const wantReflection = dayCount % 2 === 0;  // day 0 = reflection, day 1 = question, ...

  // Pull what's already been shown so we don't repeat
  const { rows: seenRows } = await pool.query(
    'SELECT content_type, content_id FROM daily_discovery WHERE user_id = $1',
    [userId],
  );
  const seenQuestions   = new Set(seenRows.filter(r => r.content_type === 'question').map(r => r.content_id));
  const seenReflections = new Set(seenRows.filter(r => r.content_type === 'reflection').map(r => r.content_id));

  if (wantReflection) {
    const profile = await buildUserProfile(userId);
    const candidates = REFLECTIONS.filter(r =>
      !seenReflections.has(r.id) &&
      r.requires.every(req => profile[req] != null) &&
      r.matches(profile)
    );
    // Fall back to always-available reflection if nothing personalized fits,
    // unless we've already shown that one too — then defer to a question.
    const chosen = candidates[0] || REFLECTIONS.find(r => r.id === 'general-quiet-recovery' && !seenReflections.has(r.id));
    if (chosen) {
      const generated = chosen.generate(profile);
      return { contentType: 'reflection', contentId: chosen.id, payload: generated };
    }
    // Reflections exhausted → fall through to question
  }

  // Question path (or fell-through from reflection)
  const unseen = BONUS_QUESTIONS.filter(q => !seenQuestions.has(String(q.id)));
  // If pool exhausted, loop from the top (acceptable — pool is large enough that
  // repeats only happen 4+ months into daily usage)
  const chosen = unseen[0] || BONUS_QUESTIONS[dayCount % BONUS_QUESTIONS.length];
  return {
    contentType: 'question',
    contentId: String(chosen.id),
    payload: {
      kicker:   'TODAY\'S DISCOVERY',
      title:    'A bonus question.',
      question: {
        id:       chosen.id,
        category: chosen.category,
        framework: chosen.framework,
        text:     chosen.text,
        options:  chosen.options,
      },
    },
  };
}

// ── GET /daily/today ──────────────────────────────────────────────────
// Returns today's discovery for the authenticated user. Idempotent
// within a calendar day.
router.get('/today', requireAuth, async (req, res) => {
  await ensureTable();
  const userId = req.user.id;
  const today  = todayISO();

  try {
    // Already-picked content for today?
    const existing = await pool.query(
      `SELECT content_type, content_id, answered, answer_value
         FROM daily_discovery
        WHERE user_id = $1 AND shown_date = $2`,
      [userId, today],
    );
    let contentType, contentId, payload, answered = false, answerValue = null;

    if (existing.rows[0]) {
      contentType = existing.rows[0].content_type;
      contentId   = existing.rows[0].content_id;
      answered    = !!existing.rows[0].answered;
      answerValue = existing.rows[0].answer_value;

      if (contentType === 'reflection') {
        const tmpl = REFLECTIONS.find(r => r.id === contentId);
        const profile = await buildUserProfile(userId);
        payload = tmpl ? tmpl.generate(profile) : {
          kicker: 'TODAY\'S REFLECTION', title: 'Reflection unavailable', body: '',
        };
      } else {
        const q = BONUS_QUESTIONS.find(qq => String(qq.id) === contentId);
        payload = {
          kicker: 'TODAY\'S DISCOVERY', title: 'A bonus question.',
          question: q ? {
            id: q.id, category: q.category, framework: q.framework, text: q.text, options: q.options,
          } : null,
        };
      }
    } else {
      // Pick new content for today
      const pick = await pickContent(userId);
      contentType = pick.contentType;
      contentId   = pick.contentId;
      payload     = pick.payload;
      await pool.query(
        `INSERT INTO daily_discovery (user_id, shown_date, content_type, content_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, shown_date) DO NOTHING`,
        [userId, today, contentType, contentId],
      );
    }

    res.json({ contentType, contentId, answered, answerValue, payload });
  } catch (err) {
    console.error('[daily-discovery] /today failed:', err);
    res.status(500).json({ error: 'Could not load today\'s discovery' });
  }
});

// ── POST /daily/today/answer ──────────────────────────────────────────
// Record the answer to today's bonus question. If today is a reflection,
// this is a no-op (returns ok:true). Safe to call without checking type.
router.post('/today/answer', requireAuth, async (req, res) => {
  await ensureTable();
  const userId = req.user.id;
  const today  = todayISO();
  const answerValue = req.body || {};

  try {
    const { rows } = await pool.query(
      `SELECT content_type, content_id FROM daily_discovery
        WHERE user_id = $1 AND shown_date = $2`,
      [userId, today],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Nothing to answer' });
    if (rows[0].content_type !== 'question') {
      return res.json({ ok: true, note: 'reflection — nothing to record' });
    }

    await pool.query(
      `UPDATE daily_discovery
          SET answered = TRUE, answer_value = $1, answered_at = NOW()
        WHERE user_id = $2 AND shown_date = $3`,
      [JSON.stringify(answerValue), userId, today],
    );

    // Best-effort: also insert into quiz_answers so the answer feeds the
    // matching engine eventually. If the column shape doesn't quite fit,
    // we silently skip — the daily_discovery row is the source of truth.
    try {
      const qid = parseInt(rows[0].content_id, 10);
      if (Number.isFinite(qid) && answerValue && typeof answerValue.optionIndex === 'number') {
        await pool.query(
          `INSERT INTO quiz_answers (user_id, question_id, answer)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, question_id) DO UPDATE SET answer = EXCLUDED.answer`,
          [userId, qid, JSON.stringify({ type: 'option', index: answerValue.optionIndex })],
        );
      }
    } catch (e) { /* swallow — daily_discovery is source of truth */ }

    res.json({ ok: true });
  } catch (err) {
    console.error('[daily-discovery] /today/answer failed:', err);
    res.status(500).json({ error: 'Could not record answer' });
  }
});

module.exports = router;
