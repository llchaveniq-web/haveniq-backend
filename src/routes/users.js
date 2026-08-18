const router  = require('express').Router();
const multer  = require('multer');
const pool    = require('../db/pool');
const { galleryJoin, photosFor } = require('../lib/photoGallery');
const { requireAuth, refuseBanned } = require('../middleware/auth');
const suspicious = require('../middleware/suspiciousActivity');
const { aiLimiter } = require('../middleware/rateLimits');
const { uploadProfilePhoto, deleteProfilePhoto, ModerationRejectedError } = require('../services/cloudinary');
const { checkPhotoSafety } = require('../services/photoSafety');
const { applyPrimaryPhotoChange } = require('../lib/primaryPhoto');
const { audit } = require('../services/auditLog');
const { isFounder } = require('../utils/founders');
const { notDemo } = require('../lib/demoFilter');
const { NO_DASH_RULE, stripDashes, stripDashesDeep } = require('../lib/textStyle');
const { screenMessage } = require('../lib/contentFilter');
const { stripSensitiveUser } = require('../lib/userSafe');
const crypto    = require('crypto');
const rateLimit = require('../lib/rateLimit');
const { ipKeyGenerator } = require('../lib/rateLimit');
const { sendParentInviteEmail, generateOTP, sendOTPEmail } = require('../services/email');
const { reportServerError } = require('./sentryTunnel');
const { eraseUserTelemetry } = require('./telemetry');

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
       WHERE school = $1 AND ${notDemo('email')}`,
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
          AND ${notDemo('email')}
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
          AND ${notDemo('email')}
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
// ── GET /users/me/sign-in-events ─────────────────────────────────────────
// Returns the authenticated user's last 20 sign-in events for the
// "Recent activity" surface on Profile. Each row exposes occurred_at,
// method, the /24-binned IP (label only — we don't expose precise IPs
// in the response), and a one-line user-agent summary. If anything
// looks wrong ("a sign-in from 192.168.x.x via Edge on Windows when I
// only ever use Safari on iPhone"), the user knows their email's been
// compromised even before the attacker takes any visible action.
// ── GET /users/me/text-insight ────────────────────────────────────────────
// Deep-matching #5: show the consenting student what we read from THEIR OWN
// writing — the living-habits construct vector + one-line rationales. Returns
// { constructs, rationales, modelVersion, computedAt } or null when the user
// hasn't consented or nothing has been extracted yet. Numbers only; never text.
router.get('/me/text-insight', requireAuth, async (req, res) => {
  try {
    const insight = await require('../services/textInsight').getOwnInsight(req.user.id);
    res.json({ insight: insight || null });
  } catch (err) {
    console.error('[users/me/text-insight] failed:', err.message);
    res.status(500).json({ error: 'failed to load text insight' });
  }
});

router.get('/me/sign-in-events', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT method, ip_prefix, user_agent, occurred_at
         FROM sign_in_events
        WHERE user_id = $1
        ORDER BY occurred_at DESC
        LIMIT 20`,
      [req.user.id],
    );
    res.json(rows.map(r => ({
      method:      r.method,
      ipPrefix:    r.ip_prefix,
      userAgent:   r.user_agent,
      occurredAt:  r.occurred_at,
    })));
  } catch (err) {
    console.error('[users/me/sign-in-events] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch sign-in events' });
  }
});

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
      // Surfaces the real 2FA state on the Profile row so the toggle
      // and setup screen can show ON vs OFF correctly. The secret +
      // recovery hashes never leave the backend — only the boolean.
      totpEnabled:     u.totp_enabled === true,
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
// The APP's option lists are the source of truth — GET /users/me returns the
// stored values verbatim, so the validator MUST accept exactly what the app
// offers or a read→re-save round-trip of an UNCHANGED field 400s. These enums
// were originally written against an invented lowercase/token vocabulary
// ('male', 'junior', 'same_gender') that the app never used — the app writes
// human labels ('Man', 'Junior', and gender labels in lookingFor). That drift
// (added with the field-validation PR) is what started rejecting untouched
// values. The matching layer already speaks the app vocab (matches.js compares
// gender/lookingFor as 'Man'/'Woman'/'Non-binary' and special-cases
// 'Prefer not to say'), so aligning here matches how the data is actually used.
//
// The legacy lowercase tokens are kept alongside the app vocab so any row
// already written in the old shape (e.g. seeded demo users) still round-trips —
// the goal is "every value GET can return is re-savable", not a hard cutover.
//   app source: app/(setup)/profile.tsx + app/match-preferences.tsx
const SCHOOL_YEARS = new Set([
  'Freshman', 'Sophomore', 'Junior', 'Senior', 'Graduate Student', 'Other',   // app
  'freshman', 'sophomore', 'junior', 'senior', 'grad',                        // legacy
]);
const GENDERS = new Set([
  'Man', 'Woman', 'Non-binary', 'Prefer not to say',                          // app
  'male', 'female', 'nonbinary', 'other', 'prefer_not',                       // legacy
]);
// lookingFor holds GENDER LABELS (who you'd live with), matched against the
// other person's `gender` — NOT the abstract preference tokens the old set had.
const LOOKING_FOR = new Set([
  'Man', 'Woman', 'Non-binary',                                               // app
  'same_gender', 'any_gender', 'lgbtq_friendly', 'no_substances', 'quiet', 'social', // legacy
]);
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
  // Cloudinary-hosted only — NOT a generic https check. This is a photo of
  // the user shown to strangers; the dedicated upload routes (POST
  // /users/me/photo, /users/me/photos) are the only places a photo actually
  // passes Cloudinary's + checkPhotoSafety's moderation, and the account
  // gets dropped back to pending review when this actually changes (see the
  // handler below). A generic https:// check here would let a client hand
  // this route ANY external image URL — completely unmoderated, and with no
  // record it was ever a "changed photo" at all.
  photo_url:       v => typeof v === 'string' && v.length <= 500 && /^https:\/\/res\.cloudinary\.com\//.test(v),
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
  // v8 hard/soft match deal-breakers (1d). Small JSON object the app saves so
  // the match query can filter on it. Strict: only known keys, correct types.
  match_dealbreakers: v => v != null && typeof v === 'object' && !Array.isArray(v) &&
    Object.keys(v).every(k => ['smokeFree','petsOk','quietHours','cleanlinessMin','maxBudget','leaseLength','moveInBy'].includes(k)) &&
    (v.smokeFree      === undefined || typeof v.smokeFree  === 'boolean') &&
    (v.petsOk         === undefined || typeof v.petsOk     === 'boolean') &&
    (v.quietHours     === undefined || typeof v.quietHours === 'boolean') &&
    (v.cleanlinessMin === undefined || ['any','moderate','very_clean','spotless'].includes(v.cleanlinessMin)) &&
    (v.maxBudget      === undefined || v.maxBudget === null || (Number.isInteger(v.maxBudget) && v.maxBudget >= 0 && v.maxBudget <= 100000)) &&
    (v.leaseLength    === undefined || (typeof v.leaseLength === 'string' && v.leaseLength.length <= 20)) &&
    (v.moveInBy       === undefined || (typeof v.moveInBy === 'string' && v.moveInBy.length <= 20)),
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

router.patch('/me', requireAuth, refuseBanned, async (req, res) => {
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
      // v8 hard/soft match filters (smokeFree/petsOk/cleanlinessMin/maxBudget…).
      matchDealbreakers: 'match_dealbreakers',
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
      } else if (snake === 'match_dealbreakers') {
        values.push(JSON.stringify(v));   // jsonb column — store as JSON text
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

    // Same rule as lib/primaryPhoto.js's applyPrimaryPhotoChange (used by the
    // dedicated upload routes): if the primary photo is actually changing
    // and the account is currently verified, that verification no longer
    // applies to what's now on display — drop back to pending review. This
    // route doesn't go through applyPrimaryPhotoChange directly (it's one
    // field in a larger batched UPDATE), but the policy must stay identical
    // or a client could bundle a photo swap into a generic profile save and
    // keep the badge. The photo_url validator above already requires a
    // Cloudinary-hosted URL — i.e. one that actually went through
    // Cloudinary's + checkPhotoSafety's moderation at upload time, not an
    // arbitrary external image.
    let reverified = false;
    if (changed.includes('photoUrl')) {
      const { rows: curRows } = await pool.query(
        'SELECT photo_url, is_verified FROM users WHERE id = $1',
        [req.user.id],
      );
      const cur = curRows[0];
      if (cur && cur.photo_url !== req.body.photoUrl && cur.is_verified === true) {
        updates.push('is_verified = FALSE');
        reverified = true;
      }
    }

    // Content moderation on the public bio. A bio is user-generated content
    // shown on the student's profile card + match detail to everyone they
    // match with, so it gets the SAME screen as a message: block egregious
    // content (slurs, threats, explicit solicitation) before it can save and
    // display. Scam/contact-info "flag" signals matter for chat, not a bio, so
    // only a hard 'block' rejects here. (writingSample is private to the AI
    // engine, not shown to others, so it isn't gated.)
    if (typeof req.body.bio === 'string' && req.body.bio.trim()) {
      const screen = screenMessage(req.body.bio);
      if (screen.action === 'block') {
        return res.status(422).json({
          code:  'content_blocked',
          error: 'That bio can\'t be saved. Keep your profile respectful and safe for the community.',
        });
      }
    }

    // Display name shown on every card/profile to strangers — screen it the
    // same way (block only; the scam/contact-info "flag" doesn't apply to a
    // name). Matters once signup is open to the public: an allowlist can be
    // trusted to self-moderate their name, a stranger can't.
    for (const nameField of ['firstName', 'lastName']) {
      const v = req.body[nameField];
      if (typeof v === 'string' && v.trim() && screenMessage(v).action === 'block') {
        return res.status(422).json({
          code:  'content_blocked',
          error: 'That name can\'t be saved. Please use your real name.',
        });
      }
    }

    values.push(req.user.id);
    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
      values
    );
    // RETURNING * carries every column — strip secrets (totp_secret, stripe id,
    // etc.) before it reaches the client. Shape is otherwise unchanged so the
    // app still gets every legitimate profile field it reads today.
    const safeUser = stripSensitiveUser(rows[0]);

    // Audit which fields changed (names only, never values — keeps PII
    // out of the audit log).
    audit(req, 'profile.patch', { fields: changed }).catch(() => {});

    // Deep-matching #5: if the bio (a text source) changed, re-extract the
    // text-insight vector — best-effort, detached, and consent-gated inside
    // extractForUser (no consent ⇒ it no-ops and purges).
    if (Array.isArray(changed) && changed.includes('bio')) {
      require('../services/textInsight').extractForUser(req.user.id).catch(() => {});
    }

    if (reverified) {
      const sendPush = req.app.get('sendPushToUser');
      sendPush?.(req.user.id, {
        title: 'Your profile is being re-reviewed',
        body: 'Your photo changed, so HavenIQ is re-checking your account — usually within about an hour. No action needed.',
        data: { screen: 'verify-edu' },
      }).catch(() => {});
    }

    res.json({ success: true, user: safeUser, reverified });
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
      checklists, vouches, safetyReportsFiled,
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
      // roommate_vouches is created lazily by roommateVouches.js's own
      // ensureTable() (not part of the boot migration) — .catch keeps a
      // fresh DB that's never taken a vouch write from 500ing the export.
      pool.query('SELECT * FROM roommate_vouches WHERE from_user_id = $1 OR about_user_id = $1 ORDER BY created_at DESC', [userId])
        .catch(() => ({ rows: [] })),
      // Reports this user FILED, not reports about them — a report under
      // active safety review shouldn't tip off its subject via their own
      // "download my data" export. See roommateSafety.js's ensureTable
      // comment for why reporter_id/reported_id are nullable (deletion
      // survival), unrelated to this scoping choice.
      pool.query('SELECT id, reported_id, category, detail, status, created_at FROM roommate_safety_reports WHERE reporter_id = $1 ORDER BY created_at DESC', [userId])
        .catch(() => ({ rows: [] })),
    ]);

    // Strip security-sensitive secrets from the user's own row before export.
    // A downloadable JSON shouldn't carry the TOTP 2FA secret, Stripe id, etc.
    // — a synced/shared/leaked export would otherwise expose them, and they
    // aren't personal data the user needs. Everything else is kept.
    const profileRow = profile.rows[0] ? stripSensitiveUser(profile.rows[0]) : null;

    // Each profile snapshot embeds a near-full copy of the users row at quiz
    // time (older rows still contain secrets even after the writer was fixed),
    // so redact the embedded `profile` on read too — otherwise the strip above
    // is defeated by the snapshot copy.
    const safeSnapshots = snapshots.rows.map((r) => {
      if (r && r.snapshot && typeof r.snapshot === 'object' && r.snapshot.profile) {
        return { ...r, snapshot: { ...r.snapshot, profile: stripSensitiveUser(r.snapshot.profile) } };
      }
      return r;
    });

    const out = {
      exported_at:           new Date().toISOString(),
      schema_version:        '1.0',
      user_id:               userId,
      profile:               profileRow,
      quiz_answers:          quiz.rows,
      profile_snapshots:     safeSnapshots,
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
      roommate_vouches:      vouches.rows,
      safety_reports_filed:  safetyReportsFiled.rows,  // reports filed BY this user only, not ones about them
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
//
// telemetry_events / pair_events / conflict_pulses / user_profile_snapshot
// use plain TEXT user_id columns with NO foreign key to users (see
// eraseUserTelemetry in telemetry.js), so the cascade above never touches
// them — this route used to just leave them in place while telling the
// student "your data has been permanently removed," which wasn't true for
// four tables holding exactly the sensitive longitudinal/behavioral data
// most worth actually deleting. Awaited (not fire-and-forget like the
// photo cleanup) so a genuine failure is caught and reported below, but a
// failure here still doesn't block the account deletion itself — a user
// who wants to leave and can't because of an unrelated telemetry-table
// hiccup is a worse outcome than a rare, reported, partial cleanup.
//
// refuseBanned is deliberate here (unlike login/support routes, which stay
// open to banned users so they can sign in and appeal): without it, a
// banned account could delete itself and re-signup with the same email —
// a fresh INSERT defaults is_banned to false — fully undoing the ban in
// seconds. Deletion is destructive, not an appeal path, so it gets no
// exception.
router.delete('/me', requireAuth, refuseBanned, async (req, res) => {
  try {
    // Audit BEFORE deletion so we still have user_id on the row. The FK
    // on audit_log.user_id is ON DELETE SET NULL so the row survives;
    // the user_id column becomes the historical "this user, now gone."
    await audit(req, 'account.delete');

    // Best-effort photo cleanup — never block account deletion on this.
    deleteProfilePhoto(req.user.id).catch(() => {});

    try {
      await eraseUserTelemetry(req.user.id);
    } catch (telemetryErr) {
      reportServerError({
        message: `Account deletion: telemetry erasure failed: ${telemetryErr && telemetryErr.message ? telemetryErr.message : 'unknown error'}`,
        stack: telemetryErr && telemetryErr.stack,
        route: 'DELETE /users/me',
        userId: req.user.id,
      });
    }

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
      `SELECT u.id, u.first_name, u.last_name, u.school, u.school_year, u.major, u.bio,
              u.gender, u.looking_for, u.photo_url, u.budget_min, u.budget_max,
              u.move_in_timeline, u.is_verified, u.trust_score, u.quiz_completed,
              ph.urls AS photo_urls
       FROM users u
       ${galleryJoin('u.id', 'ph')}
       WHERE u.id = $1 AND u.is_paused = FALSE AND COALESCE(u.is_banned, FALSE) = FALSE
         -- Same block honoring as messages.js/matches.js — a block must
         -- actually stop the blocked side from reading the other's profile,
         -- not just hide the conversation. Checked both directions so
         -- neither party can look the other up once either has blocked.
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks ub
           WHERE (ub.blocker_id = $2 AND ub.blocked_id = u.id)
              OR (ub.blocker_id = u.id AND ub.blocked_id = $2)
         )`,
      [req.params.id, req.user.id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'User not found' });

    // Privacy (policy §3): never expose more than another student's last
    // INITIAL. Full surnames live only on founder-gated admin screens. The app
    // renders "First L." from this field, so truncate it in place — closes the
    // cross-school surname-scrape without changing the payload shape the client
    // reads. (Own profile is fetched via GET /users/me, which keeps the name.)
    rows[0].last_name = (rows[0].last_name || '').trim().charAt(0).toUpperCase();

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

    // Ordered gallery (up to 4). Shaped into `photos`, and the raw aggregate
    // column dropped so the payload carries one documented field rather than an
    // internal name. photo_url stays as the single-photo fallback.
    rows[0].photos = photosFor(rows[0]);
    delete rows[0].photo_urls;

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

    // DEMO_FEED gate: only investor demos (DEMO_FEED=true) see populated
    // "who viewed your profile" lists. By default — founder included —
    // only real viewers show.
    const includeDemos = isFounder(req.user.id) && process.env.DEMO_FEED === 'true';
    const demoFilter   = includeDemos ? '' : `AND ${notDemo('u.email')}`;

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

    // Peer list → last INITIAL only (policy §3), same as everywhere else.
    res.json(rows.map(r => ({
      ...r,
      last_name: (r.last_name || '').trim().charAt(0).toUpperCase(),
    })));
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
//
// aiLimiter (40/hour/user) matches every other Claude-calling route in the
// app (matches.js's openers/explain) — this one was missing it, so a
// script could loop calls here well past the 100/normal-signup budget this
// route's own cost comment assumes. Every other AI route in the codebase
// already carries it; this was the one gap.
router.post('/me/photo/quality-check', requireAuth, refuseBanned, aiLimiter, async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'photo url required' });
  }
  // Basic URL sanity — only accept HTTPS URLs from our Cloudinary CDN.
  if (!/^https:\/\/res\.cloudinary\.com\//.test(url)) {
    return res.status(400).json({ error: 'only Cloudinary-hosted photos accepted' });
  }
  // Ownership — the domain check above only proves it's SOME Cloudinary
  // asset, not that it's THIS user's. Cloudinary public_ids are
  // deterministic (haveniq/users/<id> for the primary photo,
  // haveniq/users/<id>/gallery/<uuid> for gallery photos — see
  // services/cloudinary.js), so any authenticated caller could otherwise
  // point this at another public Cloudinary asset (anyone's, on any
  // account) and get free, repeated Claude-vision analysis run against it
  // at HavenIQ's expense — the rate limit above caps volume per caller,
  // but without this check it still caps abuse of OTHER people's images,
  // not just their own.
  let requestedPath;
  try { requestedPath = new URL(url).pathname; } catch { requestedPath = ''; }
  const escapedId = String(req.user.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ownsPhoto = new RegExp(`(?:^|/)haveniq/users/${escapedId}(?:\\.[a-zA-Z0-9]+|/gallery/[^/]+)?(?:$|[/?])`).test(requestedPath);
  if (!ownsPhoto) {
    return res.status(403).json({ error: 'you can only quality-check your own photo' });
  }

  try {
    // Single source of truth for the vision prompt + parsing + soft-fail
    // policy: services/photoSafety.js — shared with the multi-photo gallery
    // upload so the two photo paths can never diverge (this is a SAFETY
    // path; a prompt fix applied to only one copy would silently rot the
    // other). Soft-fails to safe:true on missing key / API error /
    // unparseable body, and never throws.
    const out = await checkPhotoSafety(url);
    const isUnsafe = out.safe === false;

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
        const { reverified } = await applyPrimaryPhotoChange(pool, req.user.id, null);
        if (reverified) {
          const sendPush = req.app.get('sendPushToUser');
          sendPush?.(req.user.id, {
            title: 'Your profile is being re-reviewed',
            body: 'Your photo was removed, so HavenIQ is re-checking your account — usually within about an hour. No action needed.',
            data: { screen: 'verify-edu' },
          }).catch(() => {});
        }
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
router.post('/me/photo', requireAuth, refuseBanned, photoUpload, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'photo file is required' });
    }

    const url = await uploadProfilePhoto(req.user.id, req.file.buffer);

    const { reverified } = await applyPrimaryPhotoChange(pool, req.user.id, url);
    if (reverified) {
      const sendPush = req.app.get('sendPushToUser');
      sendPush?.(req.user.id, {
        title: 'Your profile is being re-reviewed',
        body: 'Your photo changed, so HavenIQ is re-checking your account — usually within about an hour. No action needed.',
        data: { screen: 'verify-edu' },
      }).catch(() => {});
    }

    audit(req, 'photo.upload').catch(() => {});
    res.json({ url, reverified });
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

    // Keep the internal detail in the SERVER logs (+ Sentry), not in the client
    // response — a raw error string can carry Cloudinary/DB internals. The user
    // gets a clean, generic message. (Was echoing err.message to the client.)
    console.error('[photo-upload] failed:', err && err.message);
    res.status(500).json({
      error: 'Upload failed. Please try again in a moment — the team has been notified.',
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
            AND ${notDemo('email')}`),
      q(`SELECT COUNT(DISTINCT school)::int AS n FROM users
          WHERE school IS NOT NULL
            AND ${notDemo('email')}`),
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
        line: 'your matches sharpen once you finish the 17-question quiz. each answer pulls signal you wouldn\'t otherwise share.',
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
              AND ${notDemo('email')}`,
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
// 17-question quiz. The single highest-leverage "wow this app sees me"
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
// v3 (2026-06-19): shorter reveal — sections cut from 70-120 to 40-60 words
// for a quicker, punchier post-quiz read. Same 5 sections + pull quotes.
// v4 — the answer READER changed, not the prompt text. Every cached portrait
// before this was generated from "(option NaN)" lines (see the flatten fix), so
// they describe a user whose answers we appeared not to have: prod held a
// portrait reading "we're missing your cleanliness data" for an account with 33
// complete answers. Bumping the version is what invalidates them, since the
// cache key is the answer set and that has not changed.
const ABOUT_YOU_PROMPT_VERSION = 'v4';

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

// aiLimiter matches every other Claude-calling route (matches.js's
// openers/explain, and quality-check above) — the DB cache below already
// makes repeat hits with unchanged answers free (cache-hit, no Claude
// call), but a user could still force real calls by repeatedly changing
// their own answers between requests. Lower risk than the uncached
// quality-check route, but the same defense costs nothing to add.
router.get('/me/about-you', requireAuth, aiLimiter, async (req, res) => {
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

    // v8: gate readiness on the LIVE scored ids only (the 14 in the scoring
    // engine — derived from QUESTION_POINTS so this can never drift out of
    // lockstep). A profile made only of REMOVED-id answers must NOT read as
    // ready (otherwise the app shows "composing…" forever or builds a portrait
    // from questions we no longer score). >=10 live answers = the core is done.
    const { QUESTION_POINTS, flatten: flattenAnswers } = require('../services/scoring');
    const LIVE_IDS = new Set(Object.keys(QUESTION_POINTS).map(Number));
    const liveAnswers = answers.filter(a => LIVE_IDS.has(a.question_id));
    if (liveAnswers.length < 10) {
      return res.json({
        ready: false,
        reason: 'Answer at least 10 of the core quiz questions to unlock your reveal.',
        sections: [],
      });
    }

    const profile  = profileRes.rows[0] || {};
    const firstName = userRes.rows[0]?.first_name || 'you';
    const answersHash = hashAnswers(liveAnswers);  // key the cache on the live answers only

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
    const answerLines = liveAnswers
      .slice()
      .sort((a, b) => a.question_id - b.question_id)
      .map(r => {
        const q = questionsById[r.question_id];
        if (!q) return null;
        // Read the stored answer through the scorer's flatten — the ONE correct
        // reader. Production stores every answer as { type:'option', index:N },
        // and the old inline `Number(answer_value)` produced NaN for that shape,
        // so this prompt told Claude the user chose "(option NaN)" for EVERY
        // question while instructing it to treat those as ground truth. An
        // unreadable answer is now dropped rather than described wrongly.
        const flatOne = flattenAnswers({ [r.question_id]: r.answer_value });
        const chosenIndex = flatOne[r.question_id];
        if (chosenIndex === undefined) return null;
        const chosen = q.options?.[chosenIndex];
        if (chosen === undefined) return null;
        return `  • [${q.category}] "${q.text}"\n      → user chose: "${chosen}"`;
      })
      .filter(Boolean)
      .join('\n');

    const prompt = `You are writing the "About You" editorial reveal for HavenIQ, a college roommate-matching app. ${firstName} just finished the roommate-fit quiz.

This is the "wow, this app actually gets how I live" moment — the single most important brand surface in HavenIQ. Before they see their matches, they see THEMSELVES reflected back with editorial honesty and warmth.

Write a LIFESTYLE PORTRAIT: how they keep their space, run their day, handle friction with the people they live with, and what they need from a home. This is about how they LIVE, not who they "are" — ground everything in their actual answers below.

USER: ${firstName}

THEIR ACTUAL ANSWERS — each item is the FULL question text + the option they chose. Treat these as ground truth. Never invent answers or claim they said something they didn't say. The category tag in [brackets] is just for your reference.

${answerLines}

WRITE 4 EDITORIAL SECTIONS. Each:
- 40-70 words — tight and specific, NO filler. A quick satisfying read, not an essay. Every sentence earns its place.
- Second-person ("you", not "the user"), lowercase except proper nouns.
- Reference at least ONE concrete behavior from their answers, PARAPHRASED into plain everyday language. GOOD = "you clean as you go, and a sink full of dishes genuinely gets to you" / BAD = "your cleanliness score is high" or "your Q50 answer means...".
- Specific and observational, never horoscope-vague. Warm but honest — like a perceptive friend, not a marketing voice. Pure observation, NO advice, no clichés.
- ${NO_DASH_RULE}

HARD RULES — do not break these:
- This is a roommate app, NOT a personality test or therapy. NEVER use trait labels, personality types, or psychology framework names (no "attachment", "Big Five", "OCEAN", "introvert/extravert", "conscientious", "secure/anxious/avoidant", "nervous system", MBTI, "shadow", etc.). Describe the observable everyday behavior in plain words.
- NEVER diagnose, pathologize, or imply something is wrong with them. No clinical or disorder language.
- NEVER mention question numbers or Q-ids — the user has no idea what those are. Paraphrase the theme.
- Never invent answers. If the answer list doesn't cover a topic, don't write about it.

SECTION KICKERS (exactly these four, in this order):
1. HOW YOU KEEP SPACE
   — cleanliness, clutter, the shared-space standard they hold
2. HOW YOU RUN YOUR DAY
   — their rhythm: when they sleep, how they host, what they need in order to focus
3. HOW YOU HANDLE FRICTION
   — what they do when something bugs them: raise it or sit on it, who repairs first, whether they follow through on their share of the work
4. WHAT YOU NEED FROM A HOME
   — the non-negotiables: kitchen + food, drinking / smoking / overnight comfort, money

Each section ALSO needs a one-line "pull quote" — a short italic excerpt that could be lifted out as a Pinterest-style image quote. 8-14 words. Punchy.

Output ONLY valid JSON, no markdown:
{
  "sections": [
    {
      "kicker": "HOW YOU KEEP SPACE",
      "title": "<5-9 word lowercase title>",
      "body": "<40-70 word paragraph>",
      "pullQuote": "<8-14 word excerpt>"
    },
    ... (4 sections total, in the kicker order above)
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
    // Contract: 3-5 sections, each with non-empty kicker/title and a body >20
    // chars (so a malformed/blank section never renders as empty space). We
    // prompt for 4; accept >=3.
    if (sections.length < 3) {
      console.error('[about-you] validation failed:', { rawCount: sectionsRaw.length, validCount: sections.length });
      return res.json({
        ready: false,
        reason: 'Reveal generation incomplete. Pull to refresh in a minute.',
        sections: [],
      });
    }

    // House style — strip any dashes the model used as punctuation from every
    // section (body, title, kicker, pullQuote) before we cache OR return them.
    const cleanSections = stripDashesDeep(sections);

    // 4. Cache
    await pool.query(
      `INSERT INTO about_you_cache (user_id, answers_hash, sections, model, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET answers_hash = EXCLUDED.answers_hash,
             sections     = EXCLUDED.sections,
             model        = EXCLUDED.model,
             updated_at   = NOW()`,
      [userId, answersHash, JSON.stringify(cleanSections), 'claude-sonnet-4-5'],
    ).catch((e) => console.error('[about-you] cache insert failed:', e.message));

    res.json({ ready: true, sections: cleanSections, cached: false });
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

// ── DELETE /users/me/push-token ─────────────────────────────────────────
// Unregister a push token. Neither /auth/logout nor /auth/logout-all used
// to touch push_tokens at all — only account deletion did, via CASCADE.
// On a shared/resold/lent device where the app isn't reinstalled, that left
// the PREVIOUS account's push token live indefinitely: whoever logs in next
// on that physical device keeps receiving the old owner's message previews,
// connect-request names, and vouch alerts. The client calls this with its
// stored token as part of sign-out, before dropping its local session.
// Scoped to the caller's own row (token + user_id) so this can't be used to
// strip someone else's registration. No token in the body clears every
// token this user has ever registered (used by logout-all's server-side path).
router.delete('/me/push-token', requireAuth, async (req, res) => {
  try {
    const { token } = req.body || {};
    if (token !== undefined && (typeof token !== 'string' || !token)) {
      return res.status(400).json({ error: 'token must be a non-empty string' });
    }
    const { rowCount } = token
      ? await pool.query('DELETE FROM push_tokens WHERE token = $1 AND user_id = $2', [token, req.user.id])
      : await pool.query('DELETE FROM push_tokens WHERE user_id = $1', [req.user.id]);
    res.json({ success: true, removed: rowCount });
  } catch (err) {
    console.error('push-token unregister error:', err);
    res.status(500).json({ error: 'Failed to remove push token' });
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

// ── GET /users/parent-invite ──────────────────────────────────────────────
// Returns the parent email currently on the student's account (or null). Lets
// the "Loop in a parent" screen show who's looped in and offer to remove them,
// so a student always knows — and can revoke — what they've shared.
router.get('/parent-invite', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT parent_email FROM users WHERE id = $1',
      [req.user.id],
    );
    res.json({ parentEmail: rows[0]?.parent_email || null });
  } catch (err) {
    console.error('[parent-invite:get] failed:', err);
    res.status(500).json({ error: 'Failed to load parent info' });
  }
});

// ── DELETE /users/parent-invite ───────────────────────────────────────────
// Removes the parent email a student added. Consent has to be revocable — a
// student must be able to take back an email they shared. Also resets
// parent_notified so that if they later loop in a new parent, the one-time
// first-match heads-up can fire for that parent too.
router.delete('/parent-invite', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE users SET parent_email = NULL, parent_notified = FALSE WHERE id = $1',
      [req.user.id],
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[parent-invite:delete] failed:', err);
    res.status(500).json({ error: 'Failed to remove parent email' });
  }
});

// ─── Change email — self-serve, with new-address verification ──────────────
// Changing the .edu identity must prove control of the NEW inbox, or the whole
// "verified student" trust model breaks. Two authenticated steps:
//   1. POST /me/email/send-code → validate new .edu, ensure it's free, OTP it
//   2. POST /me/email/verify    → check OTP (attempt-capped), swap email
// Reuses the same otp_codes table + hashing the auth flow uses.
const CHANGE_EMAIL_ACADEMIC_TLD = /\.(edu|edu\.(au|cn|mx|ph|sg|tr|in|ng|pk|hk|tw|my|id|br|co|pe|ar)|ac\.(uk|nz|jp|kr|in|za|il|th|ir|cn|ae))$/;
const CHANGE_EMAIL_MAX_ATTEMPTS = 3;
function hashChangeEmailOtp(code) {
  return crypto.createHash('sha256').update(`${code}:${process.env.JWT_SECRET}`).digest('hex');
}
// Throttle so a logged-in user can't email-bomb a victim's inbox with codes.
const changeEmailSendLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req),
  message: { error: 'Too many requests. Wait a few minutes and try again.' },
});

router.post('/me/email/send-code', requireAuth, changeEmailSendLimit, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email is required' });
    const emailLower  = String(email).trim().toLowerCase();
    const emailDomain = emailLower.split('@')[1] || '';

    // 1. Real academic TLD — the unforgeable .edu gate.
    if (!CHANGE_EMAIL_ACADEMIC_TLD.test(emailDomain)) {
      return res.status(400).json({ error: 'Use a school email (.edu, .ac.uk, .edu.au, …).' });
    }
    // 2. Not your current email.
    const { rows: meRows } = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
    if (meRows[0] && String(meRows[0].email).toLowerCase() === emailLower) {
      return res.status(400).json({ error: "That's already your email." });
    }
    // 3. Not taken by another account.
    const { rows: taken } = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1', [emailLower]);
    if (taken[0]) {
      return res.status(409).json({ error: 'That email is already in use by another account.' });
    }
    // 4. Issue a fresh OTP (invalidate any prior unused one for this email).
    await pool.query("UPDATE otp_codes SET used = TRUE WHERE email = $1 AND used = FALSE AND purpose = 'email_change'", [emailLower]);
    const code      = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      "INSERT INTO otp_codes (email, code, expires_at, purpose) VALUES ($1, $2, $3, 'email_change')",
      [emailLower, hashChangeEmailOtp(code), expiresAt],
    );
    try {
      await sendOTPEmail(emailLower, code);
    } catch (e) {
      console.error('[me/email/send-code] email failed:', e?.message);
      return res.status(502).json({ error: 'Could not send the code. Try again in a moment.' });
    }
    res.json({ success: true, message: `Code sent to ${emailLower}` });
  } catch (err) {
    console.error('[me/email/send-code] error:', err);
    res.status(500).json({ error: 'Failed to send code' });
  }
});

router.post('/me/email/verify', requireAuth, async (req, res) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !code) return res.status(400).json({ error: 'email and code are required' });
    const emailLower  = String(email).trim().toLowerCase();
    const emailDomain = emailLower.split('@')[1] || '';
    if (!CHANGE_EMAIL_ACADEMIC_TLD.test(emailDomain)) {
      return res.status(400).json({ error: 'Use a school email (.edu, .ac.uk, .edu.au, …).' });
    }
    // Re-check it isn't taken (someone could have grabbed it between steps).
    const { rows: taken } = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = $1 AND id <> $2 LIMIT 1', [emailLower, req.user.id]);
    if (taken[0]) return res.status(409).json({ error: 'That email is already in use by another account.' });

    const { rows: otpRows } = await pool.query(
      `SELECT id, code, attempts FROM otp_codes
       WHERE email = $1 AND used = FALSE AND expires_at > NOW() AND purpose = 'email_change'
       ORDER BY created_at DESC LIMIT 1`, [emailLower]);
    if (!otpRows[0]) return res.status(400).json({ error: 'Code expired or not found. Request a new code.' });
    const otp = otpRows[0];

    // Atomic increment so the cap can't be raced.
    const { rows: bumped } = await pool.query(
      'UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts', [otp.id]);
    const attemptsAfter = bumped[0]?.attempts ?? otp.attempts + 1;
    if (attemptsAfter > CHANGE_EMAIL_MAX_ATTEMPTS) {
      await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = $1', [otp.id]);
      return res.status(400).json({ error: 'Too many attempts. Request a new code.' });
    }

    const submittedHash = hashChangeEmailOtp(String(code).trim());
    let equal = false;
    if (otp.code && otp.code.length === 64) {
      equal = crypto.timingSafeEqual(Buffer.from(otp.code, 'hex'), Buffer.from(submittedHash, 'hex'));
    } else {
      equal = otp.code === String(code).trim();
    }
    if (!equal) {
      if (attemptsAfter >= CHANGE_EMAIL_MAX_ATTEMPTS) {
        await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = $1', [otp.id]);
      }
      return res.status(400).json({ error: 'Incorrect code. Try again.' });
    }
    await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = $1', [otp.id]);

    // Swap the email + the verified domain. School stays the same — moving
    // schools is a separate, deliberate action, not a side effect of an
    // email fix. Re-check inside the UPDATE guards against a concurrent grab.
    const { rows: updated } = await pool.query(
      `UPDATE users SET email = $1, school_domain = $2
       WHERE id = $3
       RETURNING id, email, school, first_name, last_name, is_verified, trust_score, quiz_completed`,
      [emailLower, emailDomain, req.user.id]);

    audit(req, 'user.email_changed', { newDomain: emailDomain }).catch(() => {});
    res.json({ success: true, user: updated[0] });
  } catch (err) {
    console.error('[me/email/verify] error:', err);
    res.status(500).json({ error: 'Failed to change email' });
  }
});

module.exports = router;
