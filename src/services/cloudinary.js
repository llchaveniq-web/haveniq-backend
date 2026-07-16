// Cloudinary photo storage helper.
//
// Requires three env vars (set on Railway):
//   CLOUDINARY_CLOUD_NAME
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET
//
// Without these set, every uploadProfilePhoto() call rejects with a clear
// error rather than silently failing — early-launch we'd rather surface
// "storage not configured" to the dev than save photos to /dev/null.

const crypto     = require('crypto');
const cloudinary = require('cloudinary').v2;
const analytics  = require('./analytics');

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return false;
  }
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key:    CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure:     true,
  });
  configured = true;
  return true;
}

/**
 * Upload a profile photo buffer to Cloudinary, scoped to one user.
 * Returns the secure URL of the resized + optimized image.
 *
 * Uses `upload_stream` so we can pipe a multer in-memory buffer directly
 * without staging to disk. The eager transformation produces a 512×512
 * crop centered on the face — good default for avatars without making
 * the client re-upload at different sizes.
 *
 * Each user has a deterministic public_id (`haveniq/users/<userId>`) so
 * subsequent uploads OVERWRITE the previous photo. No orphaned blobs.
 */
// Sentinel error so the route can return 400 (user error) instead of 500
// when the moderator rejects a photo.
class ModerationRejectedError extends Error {
  constructor(reason) {
    super(reason || 'Photo rejected by content moderation.');
    this.name      = 'ModerationRejectedError';
    this.userError = true;  // route handler can branch on this
  }
}

// Cloudinary AWS Rekognition AI Moderation is an OPT-IN add-on that
// must be enabled in the Cloudinary dashboard (Settings → Add-ons).
// Free up to 500 images/mo. The old comment here CLAIMED Cloudinary
// silently ignores the moderation parameter if the add-on isn't
// active — that was wrong. The actual behavior is a 400 error:
//   "You don't have an active subscription for Rekognition AI Moderation"
// …which kills every photo upload. So now moderation is gated on an
// env var. Flip it ON once you've enabled the add-on in Cloudinary.
const MODERATION_ENABLED = String(process.env.ENABLE_CLOUDINARY_MODERATION || '').toLowerCase() === 'true';
if (!MODERATION_ENABLED) {
  console.warn('[cloudinary] AI moderation DISABLED. Set ENABLE_CLOUDINARY_MODERATION=true on Railway after enabling the AWS Rekognition add-on in the Cloudinary dashboard.');
}

// Shared: inspect the (synchronous, aws_rek) moderation verdict on an upload
// result. If rejected, best-effort delete the blob and return a
// ModerationRejectedError for the caller to throw; otherwise return null.
async function rejectIfModerated(result, publicId, userId, source) {
  const verdict = Array.isArray(result?.moderation) ? result.moderation[0] : null;
  if (verdict?.status !== 'rejected') return null;
  try { await cloudinary.uploader.destroy(publicId); }
  catch { /* swallow; the rejection itself is what matters */ }
  const labels = verdict.response?.moderation_labels || verdict.response?.moderationLabels || [];
  const topLabel = labels[0]?.name || labels[0]?.Name || 'inappropriate content';
  analytics.track(analytics.EVENTS.photo_flagged_nsfw, userId, { source });
  return new ModerationRejectedError(
    `Photo blocked (${topLabel}). Please upload a clear, family-friendly photo of your face.`,
  );
}

function uploadProfilePhoto(userId, buffer) {
  return new Promise((resolve, reject) => {
    if (!ensureConfigured()) {
      reject(new Error('Cloudinary not configured (missing CLOUDINARY_* env vars)'));
      return;
    }
    const uploadOptions = {
      public_id:    `haveniq/users/${userId}`,
      folder:       'haveniq/users',
      overwrite:    true,
      resource_type: 'image',
      transformation: [
        { width: 512, height: 512, gravity: 'face', crop: 'fill' },
        { quality: 'auto', fetch_format: 'auto' },
      ],
    };
    if (MODERATION_ENABLED) {
      uploadOptions.moderation = 'aws_rek';
    }
    const stream = cloudinary.uploader.upload_stream(
      uploadOptions,
      async (err, result) => {
        if (err) return reject(err);

        // AWS Rekognition is synchronous in Cloudinary — the moderation
        // verdict is included in the upload response. Statuses:
        //   'approved' — pass through
        //   'rejected' — explicit content found, delete and error
        //   'pending'  — async review (shouldn't happen for aws_rek but
        //                handled defensively — treat as approved for now,
        //                rely on a webhook later if we add async paths)
        const modErr = await rejectIfModerated(result, `haveniq/users/${userId}`, userId, 'profile_photo');
        if (modErr) return reject(modErr);
        resolve(result.secure_url);
      },
    );
    stream.end(buffer);
  });
}

/**
 * Delete a user's profile photo when they delete their account.
 * Idempotent — succeeds even if no photo exists.
 */
async function deleteProfilePhoto(userId) {
  if (!ensureConfigured()) return;
  try {
    await cloudinary.uploader.destroy(`haveniq/users/${userId}`);
  } catch {
    // Best-effort — never block account deletion on photo cleanup.
  }
}

/**
 * Upload a GALLERY photo (multi-photo profiles). Unlike uploadProfilePhoto's
 * deterministic per-user public_id (single photo, overwrites), each gallery
 * photo gets a UNIQUE public_id so several coexist. Returns { url, publicId }
 * (the caller stores public_id so it can delete this specific asset later).
 * Runs the same AI moderation gate.
 */
function uploadUserGalleryPhoto(userId, buffer) {
  return new Promise((resolve, reject) => {
    if (!ensureConfigured()) {
      reject(new Error('Cloudinary not configured (missing CLOUDINARY_* env vars)'));
      return;
    }
    const publicId = `haveniq/users/${userId}/gallery/${crypto.randomUUID()}`;
    const uploadOptions = {
      public_id:     publicId,
      overwrite:     false,
      resource_type: 'image',
      transformation: [
        { width: 512, height: 512, gravity: 'face', crop: 'fill' },
        { quality: 'auto', fetch_format: 'auto' },
      ],
    };
    if (MODERATION_ENABLED) {
      uploadOptions.moderation = 'aws_rek';
    }
    const stream = cloudinary.uploader.upload_stream(
      uploadOptions,
      async (err, result) => {
        if (err) return reject(err);
        const modErr = await rejectIfModerated(result, publicId, userId, 'gallery_photo');
        if (modErr) return reject(modErr);
        resolve({ url: result.secure_url, publicId: result.public_id });
      },
    );
    stream.end(buffer);
  });
}

/**
 * Delete one Cloudinary asset by its exact public_id (a single gallery photo).
 * Idempotent + best-effort — never throws.
 */
async function deleteByPublicId(publicId) {
  if (!ensureConfigured() || !publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch {
    // Best-effort — a DB row removal shouldn't fail on an orphaned blob.
  }
}

module.exports = {
  uploadProfilePhoto,
  deleteProfilePhoto,
  uploadUserGalleryPhoto,
  deleteByPublicId,
  ModerationRejectedError,
};
