const router  = require('express').Router();
const multer  = require('multer');
const pool    = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const suspicious = require('../middleware/suspiciousActivity');
const { uploadProfilePhoto, deleteProfilePhoto, ModerationRejectedError } = require('../services/cloudinary');
const { audit } = require('../services/auditLog');
const { isFounder } = require('../utils/founders');
const { sendParentInviteEmail } = require('../services/email');
const { reportServerError } = require('./sentryTunnel');

// 10 MB image cap — generous for a modern phone photo, still prevents
// abuse. Held in memory (no temp files on Railway's ephemeral disk) and
// streamed straight to Cloudinary via upload_stream.
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|gif)$/i;
const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    // Accept if the mimetype says image OR the filename has an image
    // extension. Web uploads (Blob -> FormData) frequently arrive with a
    // missing or generic mimetype (e.g. application/octet-stream), so the
    // extension is the reliable signal. Cloudinary's resource_type:'image'
    // is the real backstop — it rejects anything that isn't an image.
    const okMime = (file.mimetype || '').startsWith('image/');
    const okExt  = IMAGE_EXT.test(file.originalname || '');
    if (okMime || okExt) return cb(null, true);
    cb(new Error('Only image uploads are allowed'));
  },
});

// Wrap multer so its errors (rejected type, file too large, malformed
// multipart) return a clean 400 instead of bubbling to the global error
// handler as an opaque 500 "Internal server error".
function photoUpload(req, res, next) {
  uploadMiddleware.single('photo')(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'That photo is too large — please pick one under 10 MB.'
      : (err.message || 'That photo could not be uploaded.');
    res.status(400).json({ error: msg });
  });
}

// ── GET /users/signup-stats ───────────────────────────────────────────────
// Public endpoint (no auth) used by the signup screen to display live
// social proof: "12 students from your school joined this week". Returns
// rough bucketed counts so we never leak exact growth numbers school-by-
// school to anyone who probes the endpoint.
//
// Query: ?school=<exact name>
// Returns: { thisWeek: number, total: number }
router.get('/signup-stats', async (req, res) => {
  try {
    const schoolName = (req.query.school || '').toString().trim();
    if (!schoolName) return res.json({ thisWeek: 0, total: 0 });

    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS this_week,
         COUNT(*) AS total
       FROM users
       WHERE school = $1 AND email NOT LIKE '%@haveniq-demo.edu'`,
      [schoolName],
    );

    // Bucket exact counts into rough numbers to avoid leaking precise
    // school-by-school growth signal to anyone scraping this endpoint.
    const bucket = (n) => {
      const v = Number(n) || 0;
      if (v === 0)   return 0;
      if (v < 5)     return v;       // small numbers are fine ("3 joined")
      if (v < 10)    return 5;
      if (v < 25)    return 10;
      if (v < 50)    return 25;
      if (v < 100)   return 50;
      return Math.floor(v / 100) * 100;
    };

    res.json({
      thisWeek: bucket(rows[0].this_week),
      total:    bucket(rows[0].total),
    });
  } catch (err) {
    console.error('signup-stats failed:', err);
    res.json({ thisWeek: 0, total: 0 });  // never block signup on a stats error
  }
});

// ── GET /users/leaderboard ────────────────────────────────────────────────
// Real leaderboard from the `users` table — ranks by validation_score
// (HavenIQ's behavioral-trust signal) within the caller's school by
// default, or globally if ?scope=global. No fake data; if no users have
// scores yet, returns an empty list and the frontend renders an honest
// empty state.
//
// Query: ?scope=school|global  (default: school)
// Returns: Array<{ rank, id, firstName, lastInitial, school, validationScore, isMe }>
router.get('/leaderboard', requireAuth, async (req, res) => {
  try {
    const scope = (req.query.scope || 'school').toString();

    let query;
    let params;
    if (scope === 'global') {
      query = `
        SELECT id, first_name, last_name, school, validation_score
        FROM users
        WHERE is_paused = FALSE
          AND email NOT LIKE '%@haveniq-demo.edu'
          AND validation_score IS NOT NULL
        ORDER BY validation_score DESC NULLS LAST
        LIMIT 50`;
      params = [];
    } else {
      query = `
        SELECT id, first_name, last_name, school, validation_score
        FROM users
        WHERE school = $1
          AND is_paused = FALSE
          AND email NOT LIKE '%@haveniq-demo.edu'
          AND validation_score IS NOT NULL
        ORDER BY validation_score DESC NULLS LAST
        LIMIT 50`;
      params = [req.user.school];
    }

    const { rows } = await pool.query(query, params);

    res.json(rows.map((row, idx) => ({
      rank:            idx + 1,
      id:              row.id,
      firstName:       row.first_name,
      lastInitial:     (row.last_name || '').charAt(0) || '',
      school:          row.school,
      validationScore: Number(row.validation_score),
      isMe:            row.id === req.user.id,
    })));
  } catch (err) {
    console.error('leaderboard failed:', err);
    res.status(500).json({ error: 'leaderboard query failed' });
  }
});

// ── GET /users/me ─────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.*,
        (SELECT COUNT(*) FROM connect_requests WHERE to_user = u.id AND status = 'pending') as pending_requests
       FROM users u WHERE u.id = $1`,
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });

    const u = rows[0];
    res.json({
      id:              u.id,
      email:           u.email,
      school:          u.school,
      firstName:       u.first_name,
      lastName:        u.last_name,
      bio:             u.bio,
      major:           u.major,
      schoolYear:      u.school_year,
      age:             u.age,
      gender:          u.gender,
      lookingFor:      u.looking_for || [],
      photoUrl:        u.photo_url,
      budgetMin:       u.budget_min,
      budgetMax:       u.budget_max,
      moveInTimeline:  u.move_in_timeline,
      neighborhoods:   u.neighborhoods || [],
      roommateStatus:  u.roommate_status,
      isVerified:      u.is_verified,
      isPaused:        u.is_paused,
      quizCompleted:   u.quiz_completed,
      isPremium:       u.is_premium,
      trustScore:      u.trust_score,
      pendingRequests: parseInt(u.pending_requests),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ── PATCH /users/me ───────────────────────────────────────────────────────
// Per-field validators. SQL is already parameterized so injection isn't
// possible — these stop garbage data (negative ages, 100KB bios, arbitrary
// strings in enum-shaped fields) from polluting the row.
const SCHOOL_YEARS = new Set(['freshman', 'sophomore', 'junior', 'senior', 'grad']);
const GENDERS      = new Set(['male', 'female', 'nonbinary', 'other', 'prefer_not']);
const LOOKING_FOR  = new Set(['same_gender', 'any_gender', 'lgbtq_friendly', 'no_substances', 'quiet', 'social']);
const STATUSES     = new Set(['looking', 'open', 'committed', 'paused']);
const TIMELINES    = new Set(['this_month', '1-3_months', 'fall_semester', 'spring_semester', 'flexible']);
const EMAIL_RE     = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const validators = {
  first_name:      v => typeof v === 'string' && v.length > 0 && v.length <= 50,
  last_name:       v => typeof v === 'string' && v.length <= 50,
  bio:             v => typeof v === 'string' && v.length <= 2000,
  major:           v => typeof v === 'string' && v.length <= 100,
  school_year:     v => typeof v === 'string' && SCHOOL_YEARS.has(v),
  // 18+ only — TOS section 1 requires it. Server validation here is
  // the authoritative gate; the frontend's input restriction is a UX
  // nicety, not a security boundary.
  age:             v => Number.isInteger(v) && v >= 18 && v <= 99,
  gender:          v => typeof v === 'string' && GENDERS.has(v),
  looking_for:     v => Array.isArray(v) && v.length <= 10 && v.every(x => typeof x === 'string' && LOOKING_FOR.has(x)),
  photo_url:       v => typeof v === 'string' && v.length <= 500 && /^https?:\/\//.test(v),
  budget_min:      v => Number.isInteger(v) && v >= 0 && v <= 100000,
  budget_max:      v => Number.isInteger(v) && v >= 0 && v <= 100000,
  move_in_timeline:v => typeof v === 'string' && TIMELINES.has(v),
  neighborhoods:   v => Array.isArray(v) && v.length <= 20 && v.every(x => typeof x === 'string' && x.length <= 100),
  roommate_status: v => typeof v === 'string' && STATUSES.has(v),
  is_paused:       v => typeof v === 'boolean',
  parent_email:    v => typeof v === 'string' && v.length <= 200 && EMAIL_RE.test(v),
  // Dealbreaker tags — capped at 3 picks from a fixed vocab so a bad
  // payload can't fan out into weird scoring behavior. Vocab must stay
  // in lockstep with scoring.js DEALBREAKER_QUESTIONS keys.
  dealbreakers:    v => Array.isArray(v) && v.length <= 3 && v.every(x =>
    typeof x === 'string' &&
    ['sleep', 'cleanliness', 'substances', 'alcohol', 'money', 'guests', 'communication', 'noise', 'space'].includes(x)
  ),
  // Voluntary writing sample — feeds derivePersonality with richer tone +
  // voice signal than multiple-choice alone (Chad's "orthogonal info"
  // recommendation from the 2026-05-26 product session). 1000-char cap
  // keeps initial-profile-derivation token cost bounded; empty strings
  // are valid (resets the sample).
  writing_sample:  v => typeof v === 'string' && v.length <= 1000,
  // Instagram handle — text-only collection today (no OAuth scraping).
  // Strip leading @ in the validator so we store the bare username
  // consistently regardless of how the user typed it. The 30-char IG
  // cap is real; we mirror it. Empty string resets the field.
  instagram_handle: v => typeof v === 'string'
    && v.length <= 30
    && (v === '' || /^@?[a-zA-Z0-9._]{1,30}$/.test(v)),
};

router.patch('/me', requireAuth, async (req, res) => {
  try {
    const updates = [];
    const values  = [];
    let   idx     = 1;

    // Map camelCase → snake_case. Any field listed here is patchable from
    // the app's updateProfile() call. Adding a new field here + a column to
    // the users table is the entire workflow for new profile fields.
    const fieldMap = {
      firstName:      'first_name',
      lastName:       'last_name',
      bio:            'bio',
      major:          'major',
      schoolYear:     'school_year',
      age:            'age',
      gender:         'gender',
      lookingFor:     'looking_for',
      photoUrl:       'photo_url',
      budgetMin:      'budget_min',
      budgetMax:      'budget_max',
      moveInTimeline: 'move_in_timeline',
      neighborhoods:  'neighborhoods',
      roommateStatus: 'roommate_status',
      isPaused:       'is_paused',
      parentEmail:    'parent_email',
      // Up-to-3 "what matters most to me" tags chosen during profile setup.
      // Stored as TEXT[] on users; consumed by scoring.js to amplify the
      // question weights for those categories at match-scoring time. The
      // validator below caps the array length and tag vocabulary so a
      // malformed payload can't flood the scorer with bogus IDs.
      dealbreakers:   'dealbreakers',
      // Voluntary writing sample — see validator for rationale + cap.
      writingSample:  'writing_sample',
      // Instagram handle — collected as text today; OAuth scraping is a
      // future, separate project (multi-week platform approval). Stored
      // bare (no leading @) — frontend / backend both strip on read/write.
      instagramHandle: 'instagram_handle',
    };

    const invalid = [];
    const changed = [];
    for (const [camel, snake] of Object.entries(fieldMap)) {
      if (req.body[camel] === undefined) continue;
      const v = req.body[camel];
      const validate = validators[snake];
      if (validate && !validate(v)) {
        invalid.push(camel);
        continue;
      }
      updates.push(`${snake} = $${idx++}`);
      // Instagram handle is the one field that needs a normalization pass —
      // strip a leading @ so we store the bare username regardless of how
      // it was typed. Everything else writes through untouched.
      if (snake === 'instagram_handle' && typeof v === 'string' && v.startsWith('@')) {
        values.push(v.slice(1));
      } else {
        values.push(v);
      }
      changed.push(camel);
    }

    if (invalid.length > 0) {
      return res.status(400).json({ error: 'Invalid fields', fields: invalid });
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(req.user.id);
    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
      values
    );

    // Audit which fields changed (names only, never values — keeps PII
    // out of the audit log).
    audit(req, 'profile.patch', { fields: changed }).catch(() => {});

    res.json({ success: true, user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ── GET /users/me/export ──────────────────────────────────────────────────
// GDPR Article 15 — Right of Access. Returns a single JSON document
// containing every row of data we hold about the signed-in user across
// every table. Streams as a file download (Content-Disposition) so
// browsers save it directly. Push tokens are redacted; nothing else is.
router.get('/me/export', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const [
      profile, quiz, snapshots, consent, telemetry,
      requests, messages, views, scores, reviews, pulses, pushTokens,
      checklists,
    ] = await Promise.all([
      pool.query('SELECT * FROM users                   WHERE id            = $1', [userId]),
      pool.query('SELECT * FROM quiz_answers            WHERE user_id       = $1', [userId]),
      pool.query('SELECT * FROM user_profile_snapshot   WHERE user_id       = $1 ORDER BY created_at DESC', [userId]),
      pool.query('SELECT * FROM consent_log             WHERE user_id       = $1 ORDER BY created_at DESC', [userId]),
      pool.query('SELECT * FROM telemetry_events        WHERE user_id       = $1 ORDER BY client_ts DESC LIMIT 50000', [userId]),
      pool.query('SELECT * FROM connect_requests        WHERE from_user     = $1 OR to_user     = $1 ORDER BY created_at DESC', [userId]),
      pool.query('SELECT * FROM messages                WHERE sender_id     = $1 ORDER BY created_at DESC', [userId]),
      pool.query('SELECT * FROM profile_views           WHERE viewer_id     = $1 OR viewed_id   = $1 ORDER BY viewed_at DESC', [userId]),
      pool.query('SELECT * FROM compatibility_scores    WHERE user_a        = $1 OR user_b      = $1 ORDER BY calculated_at DESC', [userId]),
      pool.query('SELECT * FROM roommate_reviews        WHERE reviewer_id   = $1 OR reviewee_id = $1 ORDER BY created_at DESC', [userId]),
      pool.query('SELECT * FROM match_pulses            WHERE responder_id  = $1 ORDER BY created_at DESC', [userId]),
      pool.query('SELECT id, user_id, platform, created_at FROM push_tokens WHERE user_id = $1', [userId]),
      pool.query(`SELECT * FROM match_checklists
                  WHERE request_id IN (SELECT id FROM connect_requests WHERE from_user = $1 OR to_user = $1)`, [userId]),
    ]);

    const out = {
      exported_at:           new Date().toISOString(),
      schema_version:        '1.0',
      user_id:               userId,
      profile:               profile.rows[0] ?? null,
      quiz_answers:          quiz.rows,
      profile_snapshots:     snapshots.rows,
      consent_log:           consent.rows,
      telemetry_events:      telemetry.rows,
      connect_requests:      requests.rows,
      messages_sent:         messages.rows,
      profile_views:         views.rows,
      compatibility_scores:  scores.rows,
      roommate_reviews:      reviews.rows,
      match_pulses:          pulses.rows,
      push_tokens:           pushTokens.rows,  // token strings redacted by SELECT
      shared_checklists:     checklists.rows,
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition',
      `attachment; filename="haveniq-export-${userId.slice(0,8)}-${Date.now()}.json"`);
    res.send(JSON.stringify(out, null, 2));
  } catch (err) {
    console.error('export failed:', err);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// ── DELETE /users/me ──────────────────────────────────────────────────────
// Permanently delete the signed-in user's account. Cascading FK deletes
// remove their quiz_answers, push_tokens, connect_requests, conversations,
// compatibility_scores, profile_views, etc. Cloudinary asset is removed
// separately (best-effort) so we don't keep orphan photos in storage.
router.delete('/me', requireAuth, async (req, res) => {
  try {
    // Audit BEFORE deletion so we still have user_id on the row. The FK
    // on audit_log.user_id is ON DELETE SET NULL so the row survives;
    // the user_id column becomes the historical "this user, now gone."
    await audit(req, 'account.delete');

    // Best-effort photo cleanup — never block account deletion on this.
    deleteProfilePhoto(req.user.id).catch(() => {});

    const { rowCount } = await pool.query(
      'DELETE FROM users WHERE id = $1',
      [req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'User not found' });

    res.json({ success: true });
  } catch (err) {
    console.error('delete account error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// ── GET /users/:id ────────────────────────────────────────────────────────
// Public profile view (only basic info visible)
// 50 profile lookups in 5 min is the threshold — well above normal browsing
// (you might look at 10–20 profiles in an active session) but well below
// what a scraper trying to harvest all profiles in a school would generate.
router.get('/:id', requireAuth, suspicious.track('profile.lookup', 50), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, school, school_year, major, bio,
              gender, looking_for, photo_url, budget_min, budget_max,
              move_in_timeline, is_verified, trust_score, quiz_completed
       FROM users WHERE id = $1 AND is_paused = FALSE`,
      [req.params.id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'User not found' });

    // Record profile view (for "who viewed you" premium feature)
    if (req.user.id !== req.params.id) {
      pool.query(
        'INSERT INTO profile_views (viewer_id, viewed_id) VALUES ($1, $2)',
        [req.user.id, req.params.id]
      ).catch(err => {
        // Fire-and-forget but surface failures — silent catches caused
        // profile_views to stay at 0 rows in prod without anyone noticing.
        console.error('profile_views insert failed:', err);
      });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ── GET /users/me/viewers ─────────────────────────────────────────────────
// Premium: who viewed your profile
router.get('/me/viewers', requireAuth, async (req, res) => {
  try {
    if (!req.user.is_premium) {
      return res.status(403).json({ error: 'HavenIQ+ required to see profile viewers' });
    }

    // Founder bypass: investor demos see populated "who viewed your
    // profile" lists. Real students see only real viewers.
    const includeDemos = isFounder(req.user.id);
    const demoFilter   = includeDemos ? '' : "AND u.email NOT LIKE '%@haveniq-demo.edu'";

    const { rows } = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.school, u.photo_url, pv.viewed_at
       FROM profile_views pv
       JOIN users u ON u.id = pv.viewer_id
       WHERE pv.viewed_id = $1
         AND u.is_paused = FALSE
         ${demoFilter}
       ORDER BY pv.viewed_at DESC LIMIT 50`,
      [req.user.id]
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch viewers' });
  }
});

// ── POST /users/me/photo/quality-check ───────────────────────────────────
// AI photo-quality scorer. Frontend calls this after a successful upload
// to get a Claude-vision grade of the photo. If quality is low we surface
// a soft "want to try another?" prompt to the user. Doesn't block — the
// upload already succeeded, this is purely advisory.
//
// Why: profile photos disproportionately drive match-message rates in
// every matching app ever studied. A sharp, well-lit head shot gets
// 2-3x the response rate of a dark / sunglasses / group-photo / full-body
// shot. We don't want to be condescending about photo choice, but a
// gentle nudge before someone misses matches is worth the API cost.
//
// Cost: ~$0.003 per check (one Claude vision call, small image). At 100
// new signups/month + occasional re-uploads ≈ ~$1/month at scale.
router.post('/me/photo/quality-check', requireAuth, async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'photo url required' });
  }
  // Basic URL sanity — only accept HTTPS URLs from our Cloudinary CDN.
  if (!/^https:\/\/res\.cloudinary\.com\//.test(url)) {
    return res.status(400).json({ error: 'only Cloudinary-hosted photos accepted' });
  }

  const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY ?? '').replace(/[^!-~]/g, '');
  if (!ANTHROPIC_KEY) {
    // Soft-fail: photo upload already succeeded, quality check is best-effort
    return res.json({ score: null, summary: 'Quality check unavailable', issues: [], suggestion: null, good_enough: true });
  }

  try {
    const prompt = `You are scoring a college student's profile photo for HavenIQ, a roommate-matching app. Be HONEST but KIND — students get demoralized by harsh photo feedback. The goal is to help them get more matches, not to grade their attractiveness.

You have TWO jobs in this single call:
  A. SAFETY GATE — flag the photo as unsafe ONLY if it's clearly inappropriate for a school-affiliated roommate app.
  B. QUALITY SCORE — friendly, observational feedback on whether it'll help them match.

═══ JOB A: SAFETY GATE ═══

Mark "safe": false ONLY if the photo clearly contains:
  - Explicit nudity (genitals, bare breasts, sexual acts)
  - Sexual or suggestive content (lingerie, swimwear posed sexually, "thirst trap" framing)
  - Weapons brandished or pointed (guns, knives held aggressively)
  - Drug use (visible drugs, paraphernalia, smoking marijuana on-camera)
  - Hate symbols (swastikas, Confederate flag worn as statement, etc.)
  - Graphic violence, blood, injury
  - Photos of minors clearly under ~16 in adult-platform context

DO NOT mark unsafe for:
  - Beach photos in normal swimwear (not sexually posed)
  - Casual alcohol in background (a beer at a tailgate is fine)
  - Athletic / gym photos
  - Costumes, edgy fashion, tattoos, piercings
  - Anything that's just unflattering or low-quality — that's job B

When unsafe, fill safety_reason with ONE short sentence the user will see (e.g. "This photo contains content that isn't appropriate for a school roommate platform — please pick a different photo.").
When safe (default), set safety_reason to null.

═══ JOB B: QUALITY ASSESS (only if safe) ═══

WHAT TO ASSESS (in order of importance for a roommate-matching profile):
  1. Is the person clearly visible? Face + at least shoulders, well-lit, in focus
  2. Are their eyes visible? (sunglasses are a soft red flag, esp. indoors)
  3. Is it a SOLO photo? (group photos are confusing — who is the user?)
  4. Is the framing reasonable? (Not a tiny dot from across a room, not a selfie 2 inches from the lens)
  5. Does it look recent and authentic? (Filter-heavy or AI-generated reads as inauthentic)

WHAT'S FINE:
  - Plain background, slight smile, normal clothes — most photos
  - Slight cropping, casual lighting, hat indoors
  - Not posed / professional — students aren't supposed to look like LinkedIn headshots

WHAT'S A REAL PROBLEM:
  - Face not visible (back of head, way too dark, hands over face)
  - Multiple equally-prominent people with no clear "main"
  - Major facial obstruction (full sunglasses + hat + mask)
  - Heavily blurry / out of focus
  - Generic stock/AI photo

═══ RESPONSE FORMAT ═══

Respond ONLY with JSON. No markdown:
{
  "safe":           <boolean — false ONLY for the explicit categories listed above; default true>,
  "safety_reason":  "<one short user-facing sentence if unsafe, else null>",
  "score":          <integer 0-100, where 70+ = "good enough">,
  "summary":        "<one short, friendly, observational sentence — like a friend texting>",
  "issues":         ["<short issue 1>", "<short issue 2>"],     // 0-3 items; empty array if photo is fine
  "suggestion":     "<one actionable suggestion, or null if photo is fine>",
  "good_enough":    <boolean — true if score >= 70 OR if it's borderline but the issues are minor>
}

Examples of good summaries:
  - "Clear face, good light — solid choice."
  - "Hard to see your eyes with the sunglasses on."
  - "Cool photo but it's hard to tell which person is you."
Examples of bad summaries (do NOT write like this):
  - "This photo is bad."
  - "You should retake this photo."
  - "Your face is obscured."  (clinical, not warm)`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('[photo-quality] Anthropic', r.status, text.slice(0, 200));
      // Soft-fail — don't block the user
      return res.json({ score: null, summary: 'Quality check unavailable', issues: [], suggestion: null, good_enough: true });
    }
    const j = await r.json();
    const text = (j.content || []).find((b) => b.type === 'text')?.text ?? '{}';
    let payload;
    try {
      payload = JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim());
    } catch {
      return res.json({ score: null, summary: 'Quality check unavailable', issues: [], suggestion: null, good_enough: true });
    }

    // Defensive shape — never trust Claude to be perfect.
    // Safety default: TRUE. The model must EXPLICITLY return safe:false
    // to trigger rejection. This is intentionally conservative — a
    // false positive on safety blocks a legitimate user from using
    // their photo, which is worse for the product than the rare
    // borderline case slipping through.
    const isUnsafe = payload.safe === false;
    const out = {
      safe:          !isUnsafe,
      safety_reason: isUnsafe && typeof payload.safety_reason === 'string'
        ? payload.safety_reason.slice(0, 300)
        : null,
      score:         typeof payload.score === 'number' ? Math.max(0, Math.min(100, Math.round(payload.score))) : null,
      summary:       typeof payload.summary === 'string' ? payload.summary.slice(0, 200) : '',
      issues:        Array.isArray(payload.issues) ? payload.issues.slice(0, 3).map(String) : [],
      suggestion:    typeof payload.suggestion === 'string' ? payload.suggestion.slice(0, 200) : null,
      good_enough:   payload.good_enough !== false, // default to true unless explicitly false
    };

    // ── Hard rejection path ─────────────────────────────────────────
    // Photo flagged unsafe by Claude → delete from Cloudinary and null
    // photo_url in DB. The user's profile reverts to no-photo and the
    // frontend will show the strong rejection dialog.
    //
    // Best-effort: even if delete/DB fails, return the safety verdict
    // to the user. The next upload attempt will overwrite anyway
    // (deterministic public_id = haveniq/users/<id>), and reconciling
    // the orphan photo is preferable to silently letting an unsafe
    // photo stay live.
    if (isUnsafe) {
      try { await deleteProfilePhoto(req.user.id); }
      catch (e) { console.error('[photo-quality] delete after unsafe verdict failed:', e.message); }
      try {
        await pool.query(
          'UPDATE users SET photo_url = NULL, updated_at = NOW() WHERE id = $1',
          [req.user.id],
        );
      } catch (e) { console.error('[photo-quality] DB null after unsafe verdict failed:', e.message); }
      audit(req, 'photo.rejected.unsafe', { reason: out.safety_reason }).catch(() => {});
    }

    res.json(out);
  } catch (err) {
    console.error('[photo-quality] failed:', err.message);
    // Soft-fail in all cases — including safety. We never block a user
    // when Claude is unreachable; better to ship a borderline photo
    // through than to lock out a legitimate user during an outage.
    res.json({ safe: true, safety_reason: null, score: null, summary: 'Quality check unavailable', issues: [], suggestion: null, good_enough: true });
  }
});

// ── POST /users/me/photo ──────────────────────────────────────────────────
// Multipart upload of profile photo. Stores to Cloudinary, saves URL to
// users.photo_url. Returns `{ url }` — matches the frontend ProfileAPI
// contract. Requires CLOUDINARY_* env vars on the server.
router.post('/me/photo', requireAuth, photoUpload, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'photo file is required' });
    }

    const url = await uploadProfilePhoto(req.user.id, req.file.buffer);

    await pool.query(
      'UPDATE users SET photo_url = $1, updated_at = NOW() WHERE id = $2',
      [url, req.user.id]
    );

    audit(req, 'photo.upload').catch(() => {});
    res.json({ url });
  } catch (err) {
    console.error('photo upload error:', err);
    // Moderation rejection — user error, not a server bug. Surface the
    // specific reason from the moderator (e.g. "Explicit Nudity") so the
    // user knows what to fix instead of seeing a generic 500.
    if (err instanceof ModerationRejectedError) {
      audit(req, 'photo.upload.rejected', { reason: err.message }).catch(() => {});
      return res.status(400).json({ error: err.message });
    }
    if (err && err.message && err.message.includes('Cloudinary not configured')) {
      return res.status(503).json({ error: 'Photo storage not configured. Contact support.' });
    }
    // Real server error. Forward to the same triage pipeline that handles
    // frontend errors so the AI bot can diagnose + auto-fix. Without this
    // the user sees a generic "Upload failed" dialog and the bot never
    // hears about it (no React render error fires → no ErrorBoundary →
    // no triage). reportServerError is fire-and-forget.
    reportServerError({
      message: `Photo upload failed: ${err && err.message ? err.message : 'unknown error'}`,
      stack: err && err.stack,
      route: 'POST /users/me/photo',
      userId: req.user && req.user.id,
      context: {
        fileSize: req.file && req.file.size,
        mimeType: req.file && req.file.mimetype,
        originalName: req.file && req.file.originalname,
      },
    }).catch(() => {});

    // Surface the underlying error name to the user so they (and we)
    // can tell at a glance whether it's a Cloudinary issue, a DB issue,
    // a moderation false-positive, etc. instead of a useless generic.
    const errSummary = err && err.message
      ? err.message.slice(0, 200)
      : 'Unknown error';
    res.status(500).json({
      error: `Upload failed (${errSummary}). The team has been notified.`,
    });
  }
});

// ── POST /users/me/push-token ─────────────────────────────────────────────
// Previously `ON CONFLICT (token) DO UPDATE SET user_id = $1` let any
// ── GET /users/me/honest-state ───────────────────────────────────────
// Powers the "Honest Scale Acknowledgment" component on the frontend.
// Returns the real numbers about HavenIQ's current state so the UI can
// surface them transparently. No marketing inflation, no fake activity.
//
// Most apps fake size. HavenIQ admitting smallness is intimacy — and
// it's only intimate if the numbers are real.
router.get('/me/honest-state', requireAuth, async (req, res) => {
  try {
    // Pull live counts. Each query soft-fails to 0 so a broken count
    // never breaks the response — better to show "1 school" than
    // crash the frontend.
    const q = (sql) => pool.query(sql).then(r => r.rows[0]?.n ?? 0).catch(() => 0);
    const [students, schools, daysAlive] = await Promise.all([
      q(`SELECT COUNT(*)::int AS n FROM users
          WHERE COALESCE(is_paused, FALSE) = FALSE
            AND COALESCE(is_banned, FALSE) = FALSE
            AND email NOT LIKE '%@haveniq-demo.edu'`),
      q(`SELECT COUNT(DISTINCT school)::int AS n FROM users
          WHERE school IS NOT NULL
            AND email NOT LIKE '%@haveniq-demo.edu'`),
      q(`SELECT EXTRACT(DAY FROM NOW() - MIN(created_at))::int AS n FROM users`),
    ]);

    const weeksAlive = Math.max(1, Math.round(daysAlive / 7));

    res.json({
      students,
      schools,
      daysAlive,
      weeksAlive,
      // A pre-composed honest line the frontend can render directly.
      // Singular/plural handled here so no template logic on the client.
      line: `haveniq  ·  ${weeksAlive} week${weeksAlive === 1 ? '' : 's'} old  ·  ${students} student${students === 1 ? '' : 's'}  ·  ${schools} school${schools === 1 ? '' : 's'}`,
    });
  } catch (err) {
    console.error('[honest-state] failed:', err.message);
    res.json({
      students: 0, schools: 0, daysAlive: 0, weeksAlive: 0,
      line: 'haveniq  ·  still settling in',
    });
  }
});

// ── GET /users/me/noticings ──────────────────────────────────────────
// The "We Noticed" feature. Returns 1-3 small observations about the
// signed-in user that the app surfaces gently. The point: recognition.
// "the app noticed something about me" is deeper than "the app served
// me content." Every noticing is grounded in real database state — no
// generic horoscope content.
//
// Noticings cycle naturally as state changes:
//   • new user → "you signed up X days ago"
//   • no photo → "your profile is missing a photo — most matches start there"
//   • quiz incomplete → "you've answered N of 29 — keep going when you're ready"
//   • late-night signup → "you joined haveniq at 11pm — a quiet hour"
//   • day-of-week patterns → "you checked in 3 days running"
//   • match in pool → "X new students at your school joined this week"
//
// Returns at most 2 noticings to keep the surface light.
router.get('/me/noticings', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { rows: userRows } = await pool.query(
      `SELECT id, first_name, school, created_at, updated_at,
              photo_url IS NOT NULL AS has_photo,
              bio IS NOT NULL AND length(trim(bio)) > 0 AS has_bio,
              quiz_completed
         FROM users WHERE id = $1`,
      [userId],
    );
    const me = userRows[0];
    if (!me) return res.json({ noticings: [] });

    const noticings = [];
    const created   = new Date(me.created_at);
    const now       = new Date();
    const daysSince = Math.floor((now.getTime() - created.getTime()) / 86400000);
    const signupHour = created.getHours();

    // 1. Time-of-signup observation (one-shot, only for users in their
    //    first week so it stays fresh)
    if (daysSince <= 7) {
      if (signupHour >= 22 || signupHour < 5) {
        noticings.push({
          icon: '☾',
          line: 'you joined haveniq at a quiet hour.',
        });
      } else if (daysSince === 0) {
        noticings.push({
          icon: '✦',
          line: `welcome. take the quiz when you have ten minutes — that's when haveniq starts working.`,
        });
      } else if (daysSince <= 3) {
        noticings.push({
          icon: '✦',
          line: `you joined ${daysSince} day${daysSince === 1 ? '' : 's'} ago. no rush.`,
        });
      }
    }

    // 2. Profile completeness — surface ONLY the most actionable gap
    if (!me.quiz_completed) {
      noticings.push({
        icon: '◐',
        line: 'your matches sharpen once you finish the 29-question quiz. each answer pulls signal you wouldn\'t otherwise share.',
      });
    } else if (!me.has_photo) {
      noticings.push({
        icon: '◯',
        line: 'your profile is missing a photo. it\'s the first thing matches read about you — even a candid one counts.',
      });
    } else if (!me.has_bio) {
      noticings.push({
        icon: '◌',
        line: 'a short bio (even one sentence) doubles the chance a match sends you a hi first.',
      });
    }

    // 3. School-pool noticing — surface real activity if there is any
    if (me.school) {
      try {
        const { rows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM users
            WHERE school = $1
              AND id != $2
              AND created_at > NOW() - INTERVAL '7 days'
              AND COALESCE(is_paused, FALSE) = FALSE
              AND COALESCE(is_banned, FALSE) = FALSE
              AND email NOT LIKE '%@haveniq-demo.edu'`,
          [me.school, userId],
        );
        const newAtSchool = rows[0]?.n ?? 0;
        if (newAtSchool >= 1) {
          noticings.push({
            icon: '✦',
            line: `${newAtSchool} new student${newAtSchool === 1 ? '' : 's'} at ${me.school} this week. your pool's getting deeper.`,
          });
        }
      } catch {}
    }

    // Cap at 2 noticings — more than that and the surface feels noisy.
    res.json({ noticings: noticings.slice(0, 2) });
  } catch (err) {
    console.error('[noticings] failed:', err.message);
    res.json({ noticings: [] });
  }
});

// ── GET /users/me/about-you ──────────────────────────────────────────
// The "About You" reveal — a 5-section editorial magazine spread that
// reads the user's personality back to them after they finish the
// 29-question quiz. The single highest-leverage "wow this app sees me"
// moment in HavenIQ. Sits between quiz completion and matches.
//
// Five sections, each grounded in SPECIFIC quiz answers (not generic
// horoscope content):
//   1. THE WAY YOU REGULATE  — emotional / polyvagal answers
//   2. THE WAY YOU REPAIR    — Gottman + repair-initiator pattern
//   3. THE WAY YOU ATTACH    — Bowlby attachment pattern
//   4. YOUR HONEST EDGE      — HEXACO honesty-humility + shadow
//   5. WHAT YOU NEED FROM A HOME — lifestyle + sensory + executive function
//
// Cached in about_you_cache keyed on (user_id, answers_hash). Re-runs
// only when the user updates their quiz. Cost: ~$0.04 per generation.
// Soft-fails to a generic message on any error — the user always sees
// something, never a crash.
async function ensureAboutYouTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS about_you_cache (
      user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      answers_hash   TEXT NOT NULL,
      sections       JSONB NOT NULL,
      model          TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch((e) => console.error('[about_you_cache] ensure table:', e.message));
}

// Bump this when the About You prompt changes — the new value is folded
// into the hash so every existing cached row invalidates on next read.
// v2 (2026-06-01): replaced bare Q-id prompt with full question text +
// chosen option text. Forbids Q-numbers in output. Stops Jackson's
// "explosive anger response in Q40" hallucination.
const ABOUT_YOU_PROMPT_VERSION = 'v2';

function hashAnswers(rows) {
  // Deterministic FNV-1a-style hash of the user's quiz answer set +
  // the prompt version. Used as the cache key — re-fetching the same
  // answers returns the cached spread instantly; an updated answer OR
  // a prompt-version bump invalidates.
  const sorted = rows
    .map(r => `${r.question_id}:${JSON.stringify(r.answer_value)}`)
    .sort()
    .join('|') + '||prompt=' + ABOUT_YOU_PROMPT_VERSION;
  let h = 0x811c9dc5;
  for (let i = 0; i < sorted.length; i++) {
    h ^= sorted.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

router.get('/me/about-you', requireAuth, async (req, res) => {
  await ensureAboutYouTable();
  const userId = req.user.id;

  try {
    // 1. Pull quiz answers + personality profile (if computed)
    // SCHEMA NOTE: quiz_answers has ONE row per user with a JSONB
    // `answers` column { "1": 2, "2": 0, ... } mapping question_id
    // to option_index. NOT row-per-answer (my original assumption
    // was wrong — caught when Jackson said "I finished the quiz but
    // the reveal still says 'finish the quiz first'").
    const [answersRes, profileRes, userRes] = await Promise.all([
      pool.query(
        'SELECT answers FROM quiz_answers WHERE user_id = $1',
        [userId],
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT archetype, mbti, ocean, summary, strengths, growth_areas, roommate_fit
           FROM personality_profiles WHERE user_id = $1`,
        [userId],
      ).catch(() => ({ rows: [{}] })),
      pool.query(
        'SELECT first_name FROM users WHERE id = $1',
        [userId],
      ).catch(() => ({ rows: [{}] })),
    ]);

    // Convert the JSONB answers map into [{ question_id, answer_value }]
    // rows so the rest of the code can treat it like a row set.
    const answersMap = answersRes.rows[0]?.answers || {};
    const answers = Object.entries(answersMap).map(([qid, val]) => ({
      question_id: parseInt(qid, 10),
      answer_value: val,
    }));

    if (answers.length < 10) {
      return res.json({
        ready: false,
        reason: 'You need to answer at least 10 quiz questions before the reveal is meaningful.',
        sections: [],
      });
    }

    const profile  = profileRes.rows[0] || {};
    const firstName = userRes.rows[0]?.first_name || 'you';
    const answersHash = hashAnswers(answers);

    // 2. Cache check
    const cached = await pool.query(
      'SELECT sections, answers_hash FROM about_you_cache WHERE user_id = $1',
      [userId],
    ).catch(() => ({ rows: [] }));
    if (cached.rows[0] && cached.rows[0].answers_hash === answersHash) {
      return res.json({ ready: true, sections: cached.rows[0].sections, cached: true });
    }

    // 3. Generate via Claude
    const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY ?? '').replace(/[^!-~]/g, '');
    if (!ANTHROPIC_KEY) {
      return res.json({
        ready: false,
        reason: 'Reveal engine offline — try again in a few minutes.',
        sections: [],
      });
    }

    // Render answers with FULL question text + the option the user
    // actually chose. Without this Claude was hallucinating — Jackson
    // got back a section that referenced "explosive anger response in
    // Q40" when Q40 is actually about anxious-attachment activation.
    // Bare Q-ids told Claude nothing; it filled in the blanks from
    // training data.
    //
    // Also: the user has no idea what "Q40" is. They only see 29
    // questions in the UI; the IDs are non-contiguous (1, 3, 9, 14,
    // 15, 17, 22, 25, 29, 31, 32, 34, 35, 37, 40, 45, 48-63) for
    // historical reasons. The prompt now FORBIDS Claude from
    // referencing Q-numbers in output — it must paraphrase the theme.
    const QUIZ_QUESTIONS = require('../data/quizQuestions');
    const questionsById = Object.fromEntries(QUIZ_QUESTIONS.map(q => [q.id, q]));
    const answerLines = answers
      .slice()
      .sort((a, b) => a.question_id - b.question_id)
      .map(r => {
        const q = questionsById[r.question_id];
        if (!q) return null;
        // answer_value is the option index (a number); map to the actual chosen-option text
        const chosenIndex = typeof r.answer_value === 'number' ? r.answer_value : Number(r.answer_value);
        const chosen = q.options?.[chosenIndex] ?? '(option ' + chosenIndex + ')';
        return `  • [${q.category}] "${q.text}"\n      → user chose: "${chosen}"`;
      })
      .filter(Boolean)
      .join('\n');

    const prompt = `You are writing the "About You" editorial reveal for HavenIQ, a college roommate-matching app. The user just finished a 29-question compatibility quiz grounded in attachment theory (Bowlby), Big Five / OCEAN, Gottman communication research, polyvagal regulation, HEXACO Honesty-Humility, and executive function research.

This screen is the "wow, this app actually knows me" moment — the single most important brand surface in HavenIQ. The user is about to see if their matches are good; first they need to see THEMSELVES reflected back with editorial honesty + warmth.

USER: ${firstName}

THEIR ACTUAL ANSWERS — each item is the FULL question text + the option they chose. Treat these as ground truth. Never invent answers or claim they said something they didn't say. The category tag in [brackets] is just for your reference.

${answerLines}

THEIR COMPUTED PROFILE:
- Archetype: ${profile.archetype ?? '(not yet computed)'}
- MBTI shorthand: ${profile.mbti ?? '?'}
- Big Five (0-100): ${JSON.stringify(profile.ocean ?? {})}
- Summary: ${profile.summary ?? '(not computed)'}
- Strengths: ${JSON.stringify(profile.strengths ?? [])}
- Growth areas: ${JSON.stringify(profile.growth_areas ?? [])}

WRITE 5 EDITORIAL SECTIONS. Each:
- 70-120 words
- Second-person voice ("you", not "the user")
- Reference at least ONE specific behavior from their answers — but PARAPHRASE the question theme. Example: GOOD = "you said you go quiet when frustrated" / BAD = "your Q9 answer means..."
- NEVER mention question numbers, Q-ids, or "Q40 / question 14" — the user has no idea what those refer to. They only know they answered 29 questions.
- Specific, observational, NOT horoscope-vague
- Warm-but-honest tone — like a thoughtful friend, not a marketing voice
- NO clichés ("you're amazing!", "what makes you you!")
- NO advice; pure observation
- Lowercase except proper nouns
- Never invent answers the user didn't give. If the answer list above doesn't include a topic, don't write about it.

SECTION KICKERS (exactly these, in this order):
1. THE WAY YOU REGULATE
   — about how their nervous system handles stress, conflict, overstimulation
2. THE WAY YOU REPAIR
   — about how they handle the morning-after a fight, who initiates, who receives
3. THE WAY YOU ATTACH
   — about whether they reach out when they need someone, or pull away
4. YOUR HONEST EDGE
   — about their integrity / shadow side (HEXACO + Jungian Shadow Qs)
5. WHAT YOU NEED FROM A HOME
   — about sensory, lifestyle, cleanliness, hosting style

Each section ALSO needs a one-line "pull quote" — a short italic excerpt that could be lifted out as a Pinterest-style image quote. 8-14 words. Punchy.

Output ONLY valid JSON, no markdown:
{
  "sections": [
    {
      "kicker": "THE WAY YOU REGULATE",
      "title": "<5-9 word title in lowercase>",
      "body": "<70-120 word editorial paragraph>",
      "pullQuote": "<8-14 word italic excerpt>"
    },
    ... (5 sections total)
  ]
}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 3500,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('[about-you] Anthropic', r.status, text.slice(0, 200));
      return res.json({
        ready: false,
        reason: 'Reveal engine hiccup — try again in a minute.',
        sections: [],
      });
    }

    const j = await r.json();
    const text = (j.content || []).find((b) => b.type === 'text')?.text ?? '{}';
    let payload;
    try {
      payload = JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim());
    } catch {
      return res.json({
        ready: false,
        reason: 'Could not assemble the reveal. Try again in a minute.',
        sections: [],
      });
    }

    const sectionsRaw = Array.isArray(payload.sections) ? payload.sections.slice(0, 5) : [];

    // STRICT VALIDATION (added 2026-06-01 after Jackson reported
    // "I only see the bottom CTAs"). The previous validation only
    // checked length === 5, but a malformed Claude response could
    // satisfy that while each section had empty kicker/title/body —
    // rendering as silent blank space between masthead and colophon.
    // Now: every section must have non-empty kicker, title, AND body.
    // Any failure → ready:false with a try-again message instead of
    // an empty magazine spread.
    const sections = sectionsRaw.filter(s =>
      s && typeof s === 'object' &&
      typeof s.kicker === 'string' && s.kicker.trim().length > 0 &&
      typeof s.title  === 'string' && s.title.trim().length  > 0 &&
      typeof s.body   === 'string' && s.body.trim().length   > 20  // bodies should be real prose, not single words
    );
    if (sections.length < 5) {
      console.error('[about-you] validation failed:', { rawCount: sectionsRaw.length, validCount: sections.length });
      return res.json({
        ready: false,
        reason: 'Reveal generation incomplete. Pull to refresh in a minute.',
        sections: [],
      });
    }

    // 4. Cache
    await pool.query(
      `INSERT INTO about_you_cache (user_id, answers_hash, sections, model, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET answers_hash = EXCLUDED.answers_hash,
             sections     = EXCLUDED.sections,
             model        = EXCLUDED.model,
             updated_at   = NOW()`,
      [userId, answersHash, JSON.stringify(sections), 'claude-sonnet-4-5'],
    ).catch((e) => console.error('[about-you] cache insert failed:', e.message));

    res.json({ ready: true, sections, cached: false });
  } catch (err) {
    console.error('[about-you] failed:', err.message);
    res.json({
      ready: false,
      reason: 'Could not load your reveal right now.',
      sections: [],
    });
  }
});

// authenticated user claim another user's Expo push token and silently
// redirect their notifications. Now: a token may be re-bound to a new
// user ONLY when the existing row already belongs to the same user (the
// idempotent case where a user opens the app on a fresh install of the
// same device). Cross-user claims return 409 so the client knows the
// token belongs to someone else.
router.post('/me/push-token', requireAuth, async (req, res) => {
  try {
    const { token, platform } = req.body || {};
    if (!token || typeof token !== 'string' || token.length > 500) {
      return res.status(400).json({ error: 'token required' });
    }
    if (platform && !['ios', 'android', 'web'].includes(platform)) {
      return res.status(400).json({ error: 'invalid platform' });
    }

    const { rows: existing } = await pool.query(
      'SELECT user_id FROM push_tokens WHERE token = $1',
      [token]
    );
    if (existing[0] && existing[0].user_id !== req.user.id) {
      return res.status(409).json({ error: 'Token already registered to another account' });
    }
    if (existing[0]) {
      // Same user re-registering — refresh platform/updated_at.
      await pool.query(
        'UPDATE push_tokens SET platform = $1, updated_at = NOW() WHERE token = $2',
        [platform || 'ios', token]
      );
    } else {
      await pool.query(
        'INSERT INTO push_tokens (user_id, token, platform) VALUES ($1, $2, $3)',
        [req.user.id, token, platform || 'ios']
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('push-token error:', err);
    res.status(500).json({ error: 'Failed to save push token' });
  }
});

// ── POST /users/parent-invite ─────────────────────────────────────────────
// Student invites a parent/guardian into the loop. Stores the parent email
// on the user row and sends a warm intro email. Peace-of-mind only — the
// parent gets milestone heads-ups, never the student's private activity.
router.post('/parent-invite', requireAuth, async (req, res) => {
  try {
    const parentEmail = String(req.body?.parentEmail || '').trim().toLowerCase();
    if (!parentEmail || parentEmail.length > 200 || !EMAIL_RE.test(parentEmail)) {
      return res.status(400).json({ error: 'A valid parent email is required' });
    }

    await pool.query(
      'UPDATE users SET parent_email = $1 WHERE id = $2',
      [parentEmail, req.user.id],
    );

    try {
      await sendParentInviteEmail({ parentEmail, studentName: req.user.first_name, userId: req.user.id });
    } catch (e) {
      console.error('[parent-invite] email send failed:', e.message);
      return res.status(502).json({ error: "Saved your parent's email, but the invite couldn't send. Try again." });
    }

    res.json({ success: true, parentEmail });
  } catch (err) {
    console.error('[parent-invite] failed:', err);
    res.status(500).json({ error: 'Failed to send the parent invite' });
  }
});

module.exports = router;
