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
        transformation: [
          { width: 512, height: 512, gravity: 'face', crop: 'fill' },
          { quality: 'auto', fetch_format: 'auto' },
        ],
      },
      (err, result) => {
        if (err) return reject(err);
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

module.exports = { uploadProfilePhoto, deleteProfilePhoto };
