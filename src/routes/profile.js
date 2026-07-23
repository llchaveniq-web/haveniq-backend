/**
 * Compatibility Profile routes.
 *
 * The "AI that gets you" surface — turns everything a user has
 * voluntarily shared (quiz answers, bio, message style, behavioral
 * telemetry, optional external signal cards) into a structured
 * personality + roommate profile. Used by:
 *
 *   1. The matching algorithm (the structured vector + traits).
 *   2. The user themselves — surfaced in the "Your HavenIQ Profile"
 *      screen as the delight moment ("oh, that's actually me").
 *
 * Privacy contract:
 *   • Only data the user has already given us — never scraped.
 *   • User can view their profile (GET /users/me/profile).
 *   • User can edit any inference (PATCH /users/me/profile).
 *   • User can delete their profile alone (DELETE /users/me/profile)
 *     WITHOUT deleting their account.
 *   • Used for matching only; never sold, never used to train external models.
 *
 * Cost: ~$0.15 per synthesis. Re-synthesizes only when underlying
 * data has materially changed (cron checks daily). At 100 active
 * users this is ~$15-30/mo of Anthropic spend.
 */

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { NO_DASH_RULE, stripDashesDeep } = require('../lib/textStyle');

// ── Schema bootstrap (idempotent — runs on first call) ─────────────────
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS compatibility_profiles (
      user_id           BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      profile           JSONB NOT NULL,
      data_signature    TEXT NOT NULL,
      synthesized_at    TIMESTAMPTZ DEFAULT NOW(),
      version           INTEGER DEFAULT 1,
      user_edits        JSONB DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS idx_compatibility_profiles_synth
      ON compatibility_profiles(synthesized_at);
  `).catch((e) => console.error('[compatibility_profiles] ensure table:', e.message));

  // Manual integration signals — user-pasted equivalents of OAuth-fetched data.
  // No OAuth complexity, same signal value. Future: replace with real OAuth.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profile_external_signals (
      user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source       TEXT NOT NULL,
      content      TEXT NOT NULL,
      added_at     TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, source)
    );
  `).catch((e) => console.error('[profile_external_signals] ensure table:', e.message));
}

// ── Build the data bundle we hand to Claude ────────────────────────────
async function gatherUserData(userId) {
  const [u, quiz, msgs, signals, behavior] = await Promise.all([
    pool.query(
      `SELECT id, first_name, school, school_year, major, bio, created_at
       FROM users WHERE id = $1`,
      [userId]
    ),
    pool.query(
      `SELECT question_id, answer_value, created_at
       FROM quiz_answers WHERE user_id = $1
       ORDER BY question_id`,
      [userId]
    ).catch(() => ({ rows: [] })),
    pool.query(
      // Only THIS user's outgoing messages — never their match's incoming.
      // Style signal only, no content delivered to Claude verbatim.
      `SELECT body, created_at FROM messages
       WHERE sender_id = $1
       ORDER BY created_at DESC LIMIT 30`,
      [userId]
    ).catch(() => ({ rows: [] })),
    pool.query(
      `SELECT source, content FROM profile_external_signals
       WHERE user_id = $1`,
      [userId]
    ).catch(() => ({ rows: [] })),
    pool.query(
      // The telemetry table is wide; just count + summarize for cost reasons.
      `SELECT event_type, COUNT(*)::int AS n
       FROM telemetry_events WHERE user_id = $1
       GROUP BY event_type LIMIT 40`,
      [userId]
    ).catch(() => ({ rows: [] })),
  ]);

  const user = u.rows[0];
  if (!user) return null;

  // Style summary for messages — length distribution, emoji rate, all-lower vs mixed.
  const messages = msgs.rows || [];
  const styleSummary = messages.length === 0
    ? { count: 0 }
    : {
        count: messages.length,
        avg_len: Math.round(messages.reduce((s, m) => s + (m.body?.length || 0), 0) / messages.length),
        emoji_rate: (messages.filter((m) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(m.body || '')).length / messages.length).toFixed(2),
        all_lower_rate: (messages.filter((m) => (m.body || '') === (m.body || '').toLowerCase()).length / messages.length).toFixed(2),
        questions_rate: (messages.filter((m) => (m.body || '').includes('?')).length / messages.length).toFixed(2),
      };

  return {
    user: {
      first_name: user.first_name,
      school: user.school,
      school_year: user.school_year,
      major: user.major,
      bio: user.bio,
      days_on_platform: Math.floor((Date.now() - new Date(user.created_at).getTime()) / 86400000),
    },
    quiz: quiz.rows,
    message_style: styleSummary,
    external_signals: signals.rows,  // [{source: 'spotify', content: '...'}, ...]
    behavior_summary: behavior.rows,
  };
}

// Compute a deterministic signature of the underlying data so the cron
// can decide whether to re-synthesize. If the signature is identical
// to the last one, the profile is up-to-date.
function dataSignature(bundle) {
  const summary = {
    bio_len: bundle.user.bio?.length || 0,
    quiz_count: bundle.quiz.length,
    last_quiz_q: bundle.quiz[bundle.quiz.length - 1]?.question_id || 0,
    msg_count: bundle.message_style.count,
    signal_count: bundle.external_signals.length,
    behavior_event_types: bundle.behavior_summary.length,
  };
  // crypto.createHash would be cleaner but Node-builtin str hash is fine here
  return Buffer.from(JSON.stringify(summary)).toString('base64').slice(0, 32);
}

// ── Call Claude to synthesize ──────────────────────────────────────────
async function synthesize(bundle) {
  const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY ?? '').replace(/[^!-~]/g, '');
  if (!ANTHROPIC_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  const prompt = `You are HavenIQ's compatibility-profile synthesizer. Read the data this college student has shared with the app and produce a structured profile used for roommate matching + shown back to them as insight.

VOICE + RULES:
- This is going to be SHOWN TO THE USER. They will read what you say about them.
- So: be warm, accurate, generous, and specific. Never demeaning. Never psychobabble. Never "you have abandonment issues."
- Where the data is thin, say so in confidence_notes. Don't fabricate.
- Use plain English. No jargon. No emojis.

DATA:
${JSON.stringify(bundle, null, 2)}

Produce ONLY a JSON object matching this exact schema. No markdown, no commentary.

{
  "version": 1,
  "communication_style": {
    "warmth": <0.0-1.0>,
    "directness": <0.0-1.0>,
    "humor": "dry" | "warm" | "playful" | "deadpan" | "earnest",
    "response_pace": "fast" | "measured" | "deliberate"
  },
  "lifestyle": {
    "chronotype": "morning" | "evening" | "flexible",
    "social_battery": "high" | "medium" | "low",
    "tidy_threshold": "very low" | "low" | "medium" | "high" | "very high",
    "guest_comfort": "open" | "selective" | "rare"
  },
  "values": ["<short phrase>", "<short phrase>", "<short phrase>"],
  "conflict_pattern": "<one sentence description of how this person likely handles disagreement>",
  "roommate_archetype": "<2-4 word evocative label, e.g. 'the quiet anchor' or 'the late-night studio'>",
  "user_facing_summary": "<2-3 sentences that the user will read about themselves. Warm, specific, true. Make them feel seen, not analyzed.>",
  "growth_edges": ["<constructive phrase>", "<constructive phrase>"],
  "vector": [<16 floats between -1 and 1 — used by the matching algorithm; capture personality/lifestyle dimensions>],
  "confidence_notes": "<one sentence on what data was thin or missing>"
}

${NO_DASH_RULE}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(40_000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`anthropic ${r.status}: ${text.slice(0, 200)}`);
  }
  const j = await r.json();
  const raw = (j.content || []).find((b) => b.type === 'text')?.text ?? '{}';
  const cleaned = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim();
  const parsed = JSON.parse(cleaned);

  // Defensive — ensure vector is 16 numeric floats
  if (!Array.isArray(parsed.vector) || parsed.vector.length !== 16) {
    parsed.vector = new Array(16).fill(0);
  }
  // House style — no dashes as punctuation in any prose field. Numbers (the
  // vector) and compound-word hyphens are left untouched by stripDashesDeep.
  return stripDashesDeep(parsed);
}

// ── Routes ─────────────────────────────────────────────────────────────

// GET /users/me/profile — returns latest profile (or null if never synthesized)
router.get('/me/profile', requireAuth, async (req, res) => {
  await ensureTable();
  try {
    const { rows } = await pool.query(
      `SELECT profile, synthesized_at, version, user_edits
       FROM compatibility_profiles WHERE user_id = $1`,
      [req.user.id]
    );
    if (rows.length === 0) {
      return res.json({ profile: null, synthesized_at: null });
    }
    // Merge user_edits on top of synthesized profile so user corrections persist.
    const merged = { ...rows[0].profile, ...(rows[0].user_edits || {}) };
    res.json({
      profile: merged,
      synthesized_at: rows[0].synthesized_at,
      version: rows[0].version,
    });
  } catch (err) {
    console.error('[profile] get failed:', err);
    res.status(500).json({ error: 'profile fetch failed' });
  }
});

// POST /users/me/profile/synthesize — force fresh synthesis
// Rate-limited to one synthesis per user per 6 hours (Anthropic cost control).
const recentSynth = new Map();
router.post('/me/profile/synthesize', requireAuth, async (req, res) => {
  await ensureTable();
  const userId = req.user.id;
  const last = recentSynth.get(userId) || 0;
  if (Date.now() - last < 6 * 60 * 60 * 1000) {
    return res.status(429).json({
      error: 'profile already synthesized recently — try again later',
      retry_after_hours: Math.ceil((6 * 60 * 60 * 1000 - (Date.now() - last)) / 3600000),
    });
  }
  recentSynth.set(userId, Date.now());

  try {
    const bundle = await gatherUserData(userId);
    if (!bundle) return res.status(404).json({ error: 'user not found' });

    const signature = dataSignature(bundle);
    const profile = await synthesize(bundle);

    await pool.query(
      `INSERT INTO compatibility_profiles (user_id, profile, data_signature, synthesized_at, version)
       VALUES ($1, $2, $3, NOW(), 1)
       ON CONFLICT (user_id) DO UPDATE SET
         profile = EXCLUDED.profile,
         data_signature = EXCLUDED.data_signature,
         synthesized_at = NOW(),
         version = compatibility_profiles.version + 1`,
      [userId, profile, signature]
    );
    res.json({ profile, synthesized_at: new Date().toISOString() });
  } catch (err) {
    console.error('[profile] synthesize failed:', err);
    res.status(500).json({ error: err.message.slice(0, 200) });
  }
});

// PATCH /users/me/profile — user-facing edits (corrections to inferences)
router.patch('/me/profile', requireAuth, async (req, res) => {
  await ensureTable();
  const updates = req.body || {};
  if (typeof updates !== 'object') return res.status(400).json({ error: 'body must be an object' });

  // Allowlist what users can edit — never the vector (would break matching).
  const ALLOWED = new Set(['communication_style', 'lifestyle', 'values', 'conflict_pattern', 'roommate_archetype', 'user_facing_summary', 'growth_edges']);
  const clean = {};
  for (const [k, v] of Object.entries(updates)) {
    if (ALLOWED.has(k)) clean[k] = v;
  }

  try {
    const { rowCount } = await pool.query(
      `UPDATE compatibility_profiles
       SET user_edits = COALESCE(user_edits, '{}'::jsonb) || $2::jsonb
       WHERE user_id = $1`,
      [req.user.id, JSON.stringify(clean)]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'no profile to edit — synthesize one first' });
    res.json({ updated: true, applied: Object.keys(clean) });
  } catch (err) {
    console.error('[profile] patch failed:', err);
    res.status(500).json({ error: 'patch failed' });
  }
});

// DELETE /users/me/profile — wipes profile WITHOUT deleting account
router.delete('/me/profile', requireAuth, async (req, res) => {
  await ensureTable();
  try {
    await pool.query(
      `DELETE FROM compatibility_profiles WHERE user_id = $1`,
      [req.user.id]
    );
    res.json({ deleted: true });
  } catch (err) {
    console.error('[profile] delete failed:', err);
    res.status(500).json({ error: 'delete failed' });
  }
});

// ── External signals (manual-paste versions of Spotify/IG/LinkedIn) ────

const ALLOWED_SOURCES = new Set(['spotify_artists', 'instagram_handle', 'linkedin_url', 'voice_intro_url', 'song_of_the_week', 'tv_show_obsession']);

router.put('/me/profile/signals/:source', requireAuth, async (req, res) => {
  await ensureTable();
  const source = req.params.source;
  if (!ALLOWED_SOURCES.has(source)) return res.status(400).json({ error: 'unsupported source' });
  const content = (req.body?.content ?? '').toString().trim();
  if (content.length === 0) return res.status(400).json({ error: 'content required' });
  if (content.length > 2000) return res.status(400).json({ error: 'content too long' });

  try {
    await pool.query(
      `INSERT INTO profile_external_signals (user_id, source, content)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, source) DO UPDATE SET content = EXCLUDED.content, added_at = NOW()`,
      [req.user.id, source, content]
    );
    res.json({ saved: true });
  } catch (err) {
    console.error('[profile] signal save failed:', err);
    res.status(500).json({ error: 'signal save failed' });
  }
});

router.delete('/me/profile/signals/:source', requireAuth, async (req, res) => {
  await ensureTable();
  try {
    await pool.query(
      `DELETE FROM profile_external_signals WHERE user_id = $1 AND source = $2`,
      [req.user.id, req.params.source]
    );
    res.json({ deleted: true });
  } catch (err) {
    console.error('[profile] signal delete failed:', err);
    res.status(500).json({ error: 'signal delete failed' });
  }
});

router.get('/me/profile/signals', requireAuth, async (req, res) => {
  await ensureTable();
  try {
    const { rows } = await pool.query(
      `SELECT source, content, added_at FROM profile_external_signals
       WHERE user_id = $1`,
      [req.user.id]
    );
    res.json({ signals: rows });
  } catch (err) {
    console.error('[profile] signals get failed:', err);
    res.status(500).json({ error: 'signals fetch failed' });
  }
});

// ── Bot-admin endpoint — for the nightly refresh cron ──────────────────
// The shared internal-endpoint guard. This used to be a try/require with an
// inline fallback — and because middleware/botAuth.js did not exist, the
// fallback is what actually ran: it compared the secret with `got !== tok`,
// leaking match length through response timing. Requiring directly means a
// missing module is a loud boot error instead of a silent downgrade.
const { requireBotToken } = require('../middleware/botAuth');

// Returns users whose underlying data has changed since their last profile
// synthesis (or who never had one). Capped at 25 per call to control cost.
router.get('/bot-admin/stale-profiles', requireBotToken, async (req, res) => {
  await ensureTable();
  try {
    // Active in last 7 days AND (no profile OR profile older than 14 days OR data_signature mismatch detected on next synth).
    // Soft-fail to empty list if compatibility_profiles table or its columns
    // don't exist yet — the bot still gets a clean response and exits 0.
    const { rows } = await pool.query(`
      SELECT u.id, u.first_name, u.school
      FROM users u
      LEFT JOIN compatibility_profiles cp ON cp.user_id = u.id
      WHERE
        u.updated_at > NOW() - INTERVAL '7 days'
        AND COALESCE(u.is_banned, FALSE) = FALSE
        AND COALESCE(u.is_paused, FALSE) = FALSE
        AND (
          cp.user_id IS NULL
          OR cp.synthesized_at < NOW() - INTERVAL '14 days'
        )
      ORDER BY cp.synthesized_at NULLS FIRST
      LIMIT 25
    `).catch((e) => {
      console.warn('[profile] stale-profiles soft-fail:', e.message);
      return { rows: [] };
    });
    res.json({ count: rows.length, users: rows });
  } catch (err) {
    console.error('[profile] stale-profiles failed:', err);
    res.status(500).json({ error: 'stale profiles query failed' });
  }
});

// Bot-triggered synthesize-for-userId — same logic as POST /me/profile/synthesize
// but auth'd by bot token + targets an arbitrary user. Used by the nightly cron.
router.post('/bot-admin/synthesize/:userId', requireBotToken, async (req, res) => {
  await ensureTable();
  // user ids are UUIDs — parseInt() turned every real id into NaN → 400, so
  // this bot/cron synthesize endpoint never actually ran for anyone (the same
  // bug already fixed in matchOutcomes.js). Validate as a non-empty string.
  const userId = req.params.userId;
  if (!userId || typeof userId !== 'string') return res.status(400).json({ error: 'invalid user id' });

  try {
    const bundle = await gatherUserData(userId);
    if (!bundle) return res.status(404).json({ error: 'user not found' });

    const profile = await synthesize(bundle);
    const signature = dataSignature(bundle);

    await pool.query(
      `INSERT INTO compatibility_profiles (user_id, profile, data_signature, synthesized_at, version)
       VALUES ($1, $2, $3, NOW(), 1)
       ON CONFLICT (user_id) DO UPDATE SET
         profile = EXCLUDED.profile,
         data_signature = EXCLUDED.data_signature,
         synthesized_at = NOW(),
         version = compatibility_profiles.version + 1`,
      [userId, profile, signature]
    );
    res.json({ synthesized: true });
  } catch (err) {
    console.error(`[profile] bot synthesize for user ${userId} failed:`, err);
    res.status(500).json({ error: err.message.slice(0, 200) });
  }
});

module.exports = router;
