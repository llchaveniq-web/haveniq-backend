const router  = require('express').Router();
const multer  = require('multer');
const pool    = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { uploadProfilePhoto, deleteProfilePhoto } = require('../services/cloudinary');

// 5 MB image cap — generous for a single profile photo, prevents abuse.
// Held in memory (no temp files on Railway's ephemeral disk) and streamed
// straight to Cloudinary via upload_stream.
const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image uploads are allowed'));
    }
    cb(null, true);
  },
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
    };

    for (const [camel, snake] of Object.entries(fieldMap)) {
      if (req.body[camel] !== undefined) {
        updates.push(`${snake} = $${idx++}`);
        values.push(req.body[camel]);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(req.user.id);
    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
      values
    );

    res.json({ success: true, user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ── DELETE /users/me ──────────────────────────────────────────────────────
// Permanently delete the signed-in user's account. Cascading FK deletes
// remove their quiz_answers, push_tokens, connect_requests, conversations,
// compatibility_scores, profile_views, etc. Cloudinary asset is removed
// separately (best-effort) so we don't keep orphan photos in storage.
router.delete('/me', requireAuth, async (req, res) => {
  try {
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
router.get('/:id', requireAuth, async (req, res) => {
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
      ).catch(() => {}); // fire-and-forget
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

    const { rows } = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.school, u.photo_url, pv.viewed_at
       FROM profile_views pv
       JOIN users u ON u.id = pv.viewer_id
       WHERE pv.viewed_id = $1
       ORDER BY pv.viewed_at DESC LIMIT 50`,
      [req.user.id]
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch viewers' });
  }
});

// ── POST /users/me/photo ──────────────────────────────────────────────────
// Multipart upload of profile photo. Stores to Cloudinary, saves URL to
// users.photo_url. Returns `{ url }` — matches the frontend ProfileAPI
// contract. Requires CLOUDINARY_* env vars on the server.
router.post('/me/photo', requireAuth, uploadMiddleware.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'photo file is required' });
    }

    const url = await uploadProfilePhoto(req.user.id, req.file.buffer);

    await pool.query(
      'UPDATE users SET photo_url = $1, updated_at = NOW() WHERE id = $2',
      [url, req.user.id]
    );

    res.json({ url });
  } catch (err) {
    console.error('photo upload error:', err);
    if (err && err.message && err.message.includes('Cloudinary not configured')) {
      return res.status(503).json({ error: 'Photo storage not configured. Contact support.' });
    }
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

// ── POST /users/me/push-token ─────────────────────────────────────────────
router.post('/me/push-token', requireAuth, async (req, res) => {
  try {
    const { token, platform } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });

    await pool.query(
      `INSERT INTO push_tokens (user_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET user_id = $1`,
      [req.user.id, token, platform || 'ios']
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save push token' });
  }
});

module.exports = router;
