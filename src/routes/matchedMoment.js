/**
 * Matched Moment — the editorial reveal when two students actually match.
 *
 * Fires when both sides of a connect_request status='accepted'. Instead
 * of a generic "It's a Match!" overlay, this generates a personalized
 * reveal payload with three sections:
 *
 *   1. WHY YOU TWO WORK — Claude reads both users' quiz answers and
 *      writes a 100-150 word paragraph specifically about their pair.
 *      References specific answers from each side. NOT generic.
 *
 *   2. THINGS YOU ACTUALLY SHARE — computed from quiz-answer overlap.
 *      Returns 3-5 specific shared answers ranked by weight.
 *
 *   3. WHAT TO TALK ABOUT FIRST — 3 conversation starters Claude
 *      generates from the shared answers. Real first-message material,
 *      not "hey :)" generic openers.
 *
 * Cached per-pair to avoid re-calling Claude (deterministic content;
 * regenerates only when either user updates quiz answers).
 *
 * Cost: ~$0.04 per pair × ~1 call per match = ~$0.04 lifetime per
 * matched pair. Trivial at any scale we'll hit pre-Series-A.
 */

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const crypto = require('crypto');
const { NO_DASH_RULE, stripDashes } = require('../lib/textStyle');
const { flatten } = require('../services/scoring');

const env = (k) => (process.env[k] ?? '').replace(/[^!-~]/g, '');
const ANTHROPIC_KEY = env('ANTHROPIC_API_KEY');

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matched_moments (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_a      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payload     JSONB NOT NULL,
      answers_hash TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_a, user_b),
      CHECK (user_a < user_b)
    );
  `).catch((e) => console.error('[matched_moments] ensure table:', e.message));
}

// Bump this when the Matched Moment prompt changes — folded into the
// hash so existing cached rows invalidate on next read.
// v2 (2026-06-01): full question text + chosen option text instead of
// bare Q-ids. Forbids Q-numbers in output. Stops hallucination.
// v3 — computeSharedAnswers was comparing NaN to NaN for the production answer
// shape, so every cached reveal was built from an EMPTY shared-answers list.
// The prompt text is unchanged; the input to it was wrong, and the cache key is
// the answers, so only a version bump clears them.
const MATCHED_MOMENT_PROMPT_VERSION = 'v3';

function hashAnswers(a1, a2) {
  return crypto.createHash('sha1')
    .update(JSON.stringify(a1) + '|' + JSON.stringify(a2) + '||prompt=' + MATCHED_MOMENT_PROMPT_VERSION)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Compute the most diagnostic answers the pair share. EXACT MATCHES ONLY
 * (was ±1 in v1 — that made the count meaningless because Likert-4
 * questions hit ~50% by chance). The badge now reads honestly: each
 * shared pattern is a question where both users picked the exact same
 * option, not "close enough."
 */
function computeSharedAnswers(answersA, answersB) {
  const shared = [];
  // Read both sides through the scorer's flatten — the ONE correct reader.
  // Production stores answers as { type:'option', index:N }, for which the old
  // `Number(valA) === Number(valB)` compared NaN to NaN. That is ALWAYS false,
  // so two users with byte-identical answers shared nothing and this reveal
  // reported zero overlap for every pair on the platform.
  const flatA = flatten(answersA);
  const flatB = flatten(answersB);
  for (const [qid, valA] of Object.entries(flatA)) {
    const valB = flatB[qid];
    if (valB === undefined) continue;
    // EXACT MATCH ONLY — same option index. Anything else (even
    // adjacent on a 4-option Likert) carries weak signal: two people
    // could differ enough on one step to genuinely disagree about
    // sleep schedule, contempt patterns, etc.
    if (valA === valB) {
      shared.push({
        question_id: parseInt(qid, 10),
        index: valA,
      });
    }
  }
  // Sort by ascending question ID — Q1-Q60 are the highest-weight
  // clinical screens, so lower IDs surface more diagnostic overlap.
  shared.sort((a, b) => a.question_id - b.question_id);
  return shared.slice(0, 5);
}

async function callClaude(prompt, maxTokens = 900) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Anthropic ${r.status}: ${text.slice(0, 200)}`);
  }
  const j = await r.json();
  return (j.content || []).find(b => b.type === 'text')?.text ?? '';
}

async function generatePayload(meRow, otherRow, sharedAnswers, answersMe, answersOther) {
  const meName    = meRow.first_name || 'you';
  const otherName = otherRow.first_name || 'them';
  const school    = otherRow.school || 'your school';

  // Build rich shared-answer context with full question text + chosen
  // option text. Bare Q-ids were causing Claude to hallucinate (see
  // the parallel fix in /about-you).
  const QUIZ_QUESTIONS = require('../data/quizQuestions');
  const questionsById = Object.fromEntries(QUIZ_QUESTIONS.map(q => [q.id, q]));
  const sharedContext = sharedAnswers
    .map(s => {
      const q = questionsById[s.question_id];
      if (!q) return null;
      const idx = typeof s.index === 'number' ? s.index : (typeof s.index_a === 'number' ? s.index_a : 0);
      const choice = q.options?.[idx] ?? `(option ${idx})`;
      return `  • [${q.category}] "${q.text}"\n      → both chose: "${choice}"`;
    })
    .filter(Boolean)
    .join('\n');

  const prompt = `You are writing the "Matched Moment" reveal page for HavenIQ, a college roommate-matching app. ${meName} just matched with ${otherName} at ${school}.

Both took a 32-question quiz built on academic frameworks (Big Five, attachment theory, Gottman, polyvagal, HEXACO, executive function). Here are the SPECIFIC questions they exactly agreed on — each item is the full question text + the option they both chose. Treat these as ground truth. Never invent answers.

${sharedContext}

Write THREE pieces of content, all in second-person plural ("you two", "you both"), all in the HavenIQ editorial voice — warm, lowercase-friendly, literary, never marketing-speak. Never generic. Each sentence should be specific enough that ${meName} reading it goes "wait, that's actually us."

CRITICAL RULES:
- NEVER mention question numbers ("Q14", "question 9", etc.). The users have no idea what those refer to. They only know they answered 32 questions.
- PARAPHRASE the question theme instead. Example: GOOD = "you both go quiet rather than confront" / BAD = "Q14 shows you both..."
- Don't fabricate. If the shared list above doesn't include a topic (e.g. sleep schedule), don't write about it.
- ${NO_DASH_RULE}

1. WHY_YOU_TWO_WORK — one paragraph, 100-140 words. Reference the shared answers thematically. Be honest about what the pairing predicts: low-conflict cohabitation, fast-repair patterns, shared sensory tolerance, etc. End on a single forward-looking sentence.

2. SHARED_PATTERNS — three short observations (one sentence each, 12-20 words). Each grounded in one of the shared answers above. Format: "you both [verb] [behavior]." Examples: "you both go quiet before you confront." "you both repair conflicts by morning, not by talking it out that night."

3. CONVERSATION_STARTERS — three first-message drafts. NOT generic ("hey!") — first messages that reference a specific shared behavior and ask a follow-up question. Each 1-2 sentences. Should sound like a thoughtful college student texting another, not like an AI-generated icebreaker.

Output ONLY JSON:
{
  "why_you_two_work": "<paragraph>",
  "shared_patterns":  ["<observation 1>", "<observation 2>", "<observation 3>"],
  "conversation_starters": ["<starter 1>", "<starter 2>", "<starter 3>"]
}`;

  const raw = await callClaude(prompt);
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim());
  } catch {
    return null;
  }
  return {
    why_you_two_work: stripDashes(String(parsed.why_you_two_work || '').slice(0, 1200)),
    shared_patterns:  Array.isArray(parsed.shared_patterns) ? parsed.shared_patterns.slice(0, 3).map(s => stripDashes(String(s).slice(0, 220))) : [],
    conversation_starters: Array.isArray(parsed.conversation_starters) ? parsed.conversation_starters.slice(0, 3).map(s => stripDashes(String(s).slice(0, 300))) : [],
  };
}

// ── GET /matches/matched/:userId ──────────────────────────────────────
// Returns the Matched Moment payload for the pair (currentUser, :userId).
// Verifies they're actually matched (connect_requests accepted in either
// direction). Generates + caches the payload on first call; serves from
// cache thereafter unless either user has changed quiz answers.
router.get('/matched/:userId', requireAuth, async (req, res) => {
  await ensureTable();
  const meId = req.user.id;
  const otherId = req.params.userId;
  if (meId === otherId) return res.status(400).json({ error: 'cannot match yourself' });

  try {
    // 1. Verify they're actually matched
    const { rows: cr } = await pool.query(
      `SELECT 1 FROM connect_requests
        WHERE status = 'accepted'
          AND ((from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1))
        LIMIT 1`,
      [meId, otherId],
    );
    if (cr.length === 0) {
      return res.status(403).json({ error: 'not matched with this person yet' });
    }

    // 2. Pull both users + their answers
    const { rows: bothUsers } = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.school, u.photo_url,
              u.bio, qa.answers
         FROM users u
         LEFT JOIN quiz_answers qa ON qa.user_id = u.id
        WHERE u.id IN ($1, $2)`,
      [meId, otherId],
    );
    const meRow    = bothUsers.find(r => r.id === meId)    || {};
    const otherRow = bothUsers.find(r => r.id === otherId) || {};

    const answersMe    = meRow.answers    || {};
    const answersOther = otherRow.answers || {};

    if (Object.keys(answersMe).length < 5 || Object.keys(answersOther).length < 5) {
      // One side hasn't taken enough of the quiz for a meaningful reveal.
      // Return a graceful payload that the frontend can render.
      return res.json({
        ready: false,
        reason: 'you both need to finish more of the quiz before the full reveal lands.',
        otherUser: {
          firstName: otherRow.first_name, lastInitial: otherRow.last_name?.[0] || '',
          photoUrl: otherRow.photo_url, school: otherRow.school,
        },
      });
    }

    const sharedAnswers = computeSharedAnswers(answersMe, answersOther);

    // 3. Canonical-pair cache key. user_a < user_b is enforced by the
    // table CHECK, so sort the pair before lookup AND hash the answers
    // in the SAME canonical order — otherwise alternating-perspective
    // calls (A→B, then B→A) produce different hashes for the same pair
    // and the cache misses every time, burning Claude tokens.
    const [keyA, keyB] = [meId, otherId].sort();
    const answersForKeyA = keyA === meId ? answersMe    : answersOther;
    const answersForKeyB = keyA === meId ? answersOther : answersMe;
    const answersHash = hashAnswers(answersForKeyA, answersForKeyB);
    const { rows: cached } = await pool.query(
      `SELECT payload FROM matched_moments
        WHERE user_a = $1 AND user_b = $2 AND answers_hash = $3
        LIMIT 1`,
      [keyA, keyB, answersHash],
    );
    if (cached[0]) {
      return res.json({
        ready: true,
        cached: true,
        otherUser: {
          firstName: otherRow.first_name, lastInitial: otherRow.last_name?.[0] || '',
          photoUrl: otherRow.photo_url, school: otherRow.school, bio: otherRow.bio,
        },
        ...cached[0].payload,
        sharedCount: sharedAnswers.length,
      });
    }

    // 4. Generate fresh payload
    if (!ANTHROPIC_KEY) {
      return res.json({
        ready: false,
        reason: 'reveal generator is temporarily unavailable. try again in a few minutes.',
        otherUser: {
          firstName: otherRow.first_name, lastInitial: otherRow.last_name?.[0] || '',
          photoUrl: otherRow.photo_url, school: otherRow.school,
        },
      });
    }
    const payload = await generatePayload(meRow, otherRow, sharedAnswers, answersMe, answersOther);
    if (!payload) {
      return res.status(500).json({ error: 'could not generate matched moment' });
    }

    // 5. Cache + return
    await pool.query(
      `INSERT INTO matched_moments (user_a, user_b, payload, answers_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_a, user_b)
       DO UPDATE SET payload = EXCLUDED.payload, answers_hash = EXCLUDED.answers_hash, created_at = NOW()`,
      [keyA, keyB, JSON.stringify(payload), answersHash],
    );

    res.json({
      ready: true,
      cached: false,
      otherUser: {
        firstName: otherRow.first_name, lastInitial: otherRow.last_name?.[0] || '',
        photoUrl: otherRow.photo_url, school: otherRow.school, bio: otherRow.bio,
      },
      ...payload,
      sharedCount: sharedAnswers.length,
    });
  } catch (err) {
    console.error('[matched-moment] failed:', err.message);
    res.status(500).json({ error: 'could not load matched moment' });
  }
});

module.exports = router;
