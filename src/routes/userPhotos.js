// Multi-photo profiles — the user_photos gallery (up to 6 per user).
//
// Mounted at /users (alongside routes/users.js, routes/profile.js). The legacy
// single users.photo_url stays authoritative for the PRIMARY photo and is kept
// synced to the position-0 gallery photo, so every existing consumer of
// photo_url (feed, cards, etc.) keeps working untouched.
//
// Reuses the existing Cloudinary upload + AI-moderation (services/cloudinary)
// and the Claude-vision safety verdict (services/photoSafety) — same gates the
// single POST /users/me/photo uses.
//
// Every write route here also stacks refuseBanned. A banned account was
// previously able to keep uploading/reordering/deleting photos indefinitely
// — it just wouldn't surface them in anyone's NEW match feed (matches.js
// filters is_banned at read time). That still left an already-confirmed bad
// actor free to keep changing what anyone with an existing connection or
// open conversation sees on their profile.

const router  = require('express').Router();
const multer  = require('multer');
const pool    = require('../db/pool');
const { requireAuth, refuseBanned } = require('../middleware/auth');
const { uploadUserGalleryPhoto, deleteByPublicId, ModerationRejectedError } = require('../services/cloudinary');
const { checkPhotoSafety } = require('../services/photoSafety');
const { applyPrimaryPhotoChange } = require('../lib/primaryPhoto');
const { audit } = require('../services/auditLog');

const MAX_PHOTOS = 6;

// ── Multipart handling (mirrors routes/users.js photoUpload) ────────────────
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|gif)$/i;
const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const okMime = (file.mimetype || '').startsWith('image/');
    const okExt  = IMAGE_EXT.test(file.originalname || '');
    if (okMime || okExt) return cb(null, true);
    cb(new Error('Only image uploads are allowed'));
  },
});
function photoUpload(req, res, next) {
  uploadMiddleware.single('photo')(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'That photo is too large — please pick one under 10 MB.'
      : (err.message || 'That photo could not be uploaded.');
    res.status(400).json({ error: msg });
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// Two users are "connected" when an accepted connect_request exists in EITHER
// direction — same relationship the rest of the app treats as a real match.
async function areConnected(a, b) {
  const { rows } = await pool.query(
    `SELECT 1 FROM connect_requests
      WHERE status = 'accepted'
        AND ((from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1))
      LIMIT 1`,
    [a, b],
  );
  return rows.length > 0;
}

// Keep the legacy users.photo_url pointed at the current position-0 gallery
// photo (or NULL when the gallery is empty), so nothing that reads photo_url
// ever sees a stale/deleted image. Returns { reverified } — true when this
// change dropped a previously-verified account back to pending review (see
// lib/primaryPhoto.js) so callers can tell the user why.
async function syncPrimaryPhoto(userId) {
  const { rows } = await pool.query(
    'SELECT url FROM user_photos WHERE user_id = $1 ORDER BY position ASC LIMIT 1',
    [userId],
  );
  const { reverified } = await applyPrimaryPhotoChange(pool, userId, rows[0]?.url ?? null);
  return { reverified };
}

// Best-effort push explaining the re-review — never blocks the response it's
// called from. Reuses the same fire-and-forget convention as every other
// push in the app (see roommateVouches.js, matchOutcomes.js).
function notifyReverification(req, userId) {
  const sendPush = req.app.get('sendPushToUser');
  if (!sendPush) return;
  sendPush(userId, {
    title: 'Your profile is being re-reviewed',
    body: 'Your photo changed, so HavenIQ is re-checking your account — usually within about an hour. No action needed.',
    data: { screen: 'verify-edu' },
  }).catch(() => {});
}

// ── GET /users/:id/photos ───────────────────────────────────────────────────
// Ordered gallery. Visible to the owner OR a connected match, else 403.
router.get('/:id/photos', requireAuth, async (req, res) => {
  try {
    const targetId = req.params.id;
    if (req.user.id !== targetId && !(await areConnected(req.user.id, targetId))) {
      return res.status(403).json({ error: 'Not allowed to view these photos' });
    }
    const { rows } = await pool.query(
      'SELECT id, url, position FROM user_photos WHERE user_id = $1 ORDER BY position ASC',
      [targetId],
    );
    res.json(rows);
  } catch (err) {
    console.error('[user-photos] list failed:', err.message);
    res.status(500).json({ error: 'Failed to load photos' });
  }
});

// ── POST /users/me/photos ───────────────────────────────────────────────────
// Multipart "photo". 409 if already at the cap; else Cloudinary upload → AI
// safety check → on unsafe delete the asset + 422; else insert at end. If it
// lands at position 0 (first photo), sync users.photo_url. Returns {id,url,position}.
router.post('/me/photos', requireAuth, refuseBanned, photoUpload, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'photo file is required' });

  let publicId = null;
  try {
    // Cheap cap check BEFORE spending a Cloudinary upload.
    const { rows: cnt } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM user_photos WHERE user_id = $1',
      [req.user.id],
    );
    if (cnt[0].n >= MAX_PHOTOS) {
      return res.status(409).json({ error: `You can have at most ${MAX_PHOTOS} photos.` });
    }

    const uploaded = await uploadUserGalleryPhoto(req.user.id, req.file.buffer);
    publicId = uploaded.publicId;

    // Claude-vision safety gate (same verdict as the single-photo route). On an
    // explicit unsafe verdict: delete the just-uploaded asset and 422.
    const verdict = await checkPhotoSafety(uploaded.url);
    if (!verdict.safe) {
      await deleteByPublicId(publicId);
      audit(req, 'photo.gallery.rejected.unsafe', { reason: verdict.safety_reason }).catch(() => {});
      return res.status(422).json({
        error: verdict.safety_reason
          || "This photo isn't appropriate for a school roommate platform — please pick a different one.",
      });
    }

    // Insert at MAX(position)+1, but only if still under the cap — the HAVING
    // makes the cap atomic against a concurrent second upload.
    const { rows: ins } = await pool.query(
      `INSERT INTO user_photos (user_id, url, public_id, position)
       SELECT $1, $2, $3, COALESCE(MAX(position), -1) + 1
         FROM user_photos WHERE user_id = $1
        HAVING COUNT(*) < $4
       RETURNING id, url, position`,
      [req.user.id, uploaded.url, publicId, MAX_PHOTOS],
    );
    if (ins.length === 0) {
      // Raced past the cap between the check and the insert — clean up the blob.
      await deleteByPublicId(publicId);
      return res.status(409).json({ error: `You can have at most ${MAX_PHOTOS} photos.` });
    }

    let reverified = false;
    if (ins[0].position === 0) {
      ({ reverified } = await syncPrimaryPhoto(req.user.id));
      if (reverified) notifyReverification(req, req.user.id);
    }

    audit(req, 'photo.gallery.upload').catch(() => {});
    res.json({ ...ins[0], reverified });
  } catch (err) {
    // Cloudinary AI moderation rejection — user error, surface the reason.
    if (err instanceof ModerationRejectedError) {
      audit(req, 'photo.gallery.upload.rejected', { reason: err.message }).catch(() => {});
      return res.status(400).json({ error: err.message });
    }
    if (err && err.message && err.message.includes('Cloudinary not configured')) {
      return res.status(503).json({ error: 'Photo storage not configured. Contact support.' });
    }
    // Best-effort cleanup of an orphaned upload on an unexpected failure.
    if (publicId) { deleteByPublicId(publicId).catch(() => {}); }
    console.error('[user-photos] upload failed:', err && err.message);
    res.status(500).json({ error: 'Upload failed. Please try again in a moment.' });
  }
});

// ── DELETE /users/me/photos/:photoId ────────────────────────────────────────
// Remove one of your own photos: delete the Cloudinary asset + row, re-pack the
// remaining positions to stay contiguous, and re-sync users.photo_url.
router.delete('/me/photos/:photoId', requireAuth, refuseBanned, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT public_id, position FROM user_photos WHERE id = $1 AND user_id = $2',
      [req.params.photoId, req.user.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Photo not found' });
    const { public_id: publicId, position } = rows[0];

    await pool.query('DELETE FROM user_photos WHERE id = $1 AND user_id = $2', [req.params.photoId, req.user.id]);
    // Close the gap so positions stay 0..n-1 and contiguous.
    await pool.query(
      'UPDATE user_photos SET position = position - 1 WHERE user_id = $1 AND position > $2',
      [req.user.id, position],
    );
    const { reverified } = await syncPrimaryPhoto(req.user.id);
    if (reverified) notifyReverification(req, req.user.id);

    // Best-effort blob removal after the DB is consistent.
    await deleteByPublicId(publicId);

    audit(req, 'photo.gallery.delete').catch(() => {});
    res.json({ success: true, reverified });
  } catch (err) {
    console.error('[user-photos] delete failed:', err.message);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

// ── PATCH /users/me/photos/reorder ──────────────────────────────────────────
// Body: { order: [photoId, ...] } — must be exactly the user's photo ids. Rewrites
// positions to that order and re-syncs users.photo_url to the new position-0.
router.patch('/me/photos/reorder', requireAuth, refuseBanned, async (req, res) => {
  try {
    const order = req.body && req.body.order;
    if (!Array.isArray(order) || order.length === 0 || !order.every((id) => typeof id === 'string' && id)) {
      return res.status(400).json({ error: 'order must be a non-empty array of photo ids' });
    }

    const { rows } = await pool.query('SELECT id FROM user_photos WHERE user_id = $1', [req.user.id]);
    const owned = new Set(rows.map((r) => r.id));
    const uniqueOrder = new Set(order);
    // The order must be a permutation of EXACTLY the user's photos — no dupes,
    // no unknown/foreign ids, no missing ones.
    if (uniqueOrder.size !== order.length || order.length !== owned.size || !order.every((id) => owned.has(id))) {
      return res.status(400).json({ error: 'order must list each of your photos exactly once' });
    }

    // No UNIQUE(user_id, position), so straight sequential writes are safe.
    for (let i = 0; i < order.length; i++) {
      await pool.query(
        'UPDATE user_photos SET position = $1 WHERE id = $2 AND user_id = $3',
        [i, order[i], req.user.id],
      );
    }
    const { reverified } = await syncPrimaryPhoto(req.user.id);
    if (reverified) notifyReverification(req, req.user.id);

    const { rows: out } = await pool.query(
      'SELECT id, url, position FROM user_photos WHERE user_id = $1 ORDER BY position ASC',
      [req.user.id],
    );
    audit(req, 'photo.gallery.reorder').catch(() => {});
    res.json({ photos: out, reverified });
  } catch (err) {
    console.error('[user-photos] reorder failed:', err.message);
    res.status(500).json({ error: 'Failed to reorder photos' });
  }
});

module.exports = router;
