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

function uploadProfilePhoto(userId, buffer) {
  return new Promise((resolve, reject) => {
    if (!ensureConfigured()) {
      reject(new Error('Cloudinary not configured (missing CLOUDINARY_* env vars)'));
      return;
    }
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id:    `haveniq/users/${userId}`,
        folder:       'haveniq/users',
        overwrite:    true,
        resource_type: 'image',
        // Auto-moderate using AWS Rekognition. Free in Cloudinary up to
        // 500 images/mo, then ~$1/1k. Requires the "Amazon Rekognition AI
        // Moderation" add-on to be enabled in the Cloudinary dashboard
        // (Settings → Add-ons → free signup). If the add-on isn't enabled,
        // Cloudinary silently ignores this parameter and the upload
        // succeeds — so it's safe to ship before activation. Once enabled,
        // explicit / suggestive content is blocked automatically.
        moderation: 'aws_rek',
        transformation: [
          { width: 512, height: 512, gravity: 'face', crop: 'fill' },
          { quality: 'auto', fetch_format: 'auto' },
        ],
      },
      async (err, result) => {
        if (err) return reject(err);

        // AWS Rekognition is synchronous in Cloudinary — the moderation
        // verdict is included in the upload response. Statuses:
        //   'approved' — pass through
        //   'rejected' — explicit content found, delete and error
        //   'pending'  — async review (shouldn't happen for aws_rek but
        //                handled defensively — treat as approved for now,
        //                rely on a webhook later if we add async paths)
        const verdict = Array.isArray(result?.moderation) ? result.moderation[0] : null;
        if (verdict?.status === 'rejected') {
          // Best-effort cleanup of the rejected blob — no point storing it.
          try { await cloudinary.uploader.destroy(`haveniq/users/${userId}`); }
          catch { /* swallow; the rejection itself is what matters */ }
          const labels = verdict.response?.moderation_labels || verdict.response?.moderationLabels || [];
          const topLabel = labels[0]?.name || labels[0]?.Name || 'inappropriate content';
          analytics.track(analytics.EVENTS.photo_flagged_nsfw, userId, {
            source: 'profile_photo',
          });
          return reject(new ModerationRejectedError(
            `Photo blocked (${topLabel}). Please upload a clear, family-friendly photo of your face.`,
          ));
        }
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

module.exports = { uploadProfilePhoto, deleteProfilePhoto, ModerationRejectedError };
