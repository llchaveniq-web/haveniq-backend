// Shared write path for the users.photo_url column — every route that can
// change a user's PRIMARY photo (single-photo upload, gallery position-0
// sync, the unsafe-photo rejection null-out) goes through this so the rule
// can't drift or get missed on one path.
//
// The rule: is_verified means "HavenIQ's signup-review bot/founder looked at
// THIS profile, including the photo currently shown as primary, and approved
// it." That stops being true the instant the primary photo changes — a
// verified user swapping to a different photo (someone else's, a stock
// image, one the vision safety check would have flagged, or just an
// unreviewed new one) would otherwise keep the badge forever with a photo
// nobody ever screened. So: any real change to the primary photo while
// is_verified is TRUE drops it back to FALSE, re-queuing the account for
// review through the exact same pipeline a brand-new signup goes through
// (botAdmin.js's bot / admin.js's founder — see auth.js for the original
// signup-time reasoning).
async function applyPrimaryPhotoChange(pool, userId, newUrl) {
  const { rows } = await pool.query(
    'SELECT photo_url, is_verified FROM users WHERE id = $1',
    [userId],
  );
  const cur = rows[0];
  if (!cur) return { changed: false, reverified: false };

  // Normalize null/undefined so "no photo → no photo" isn't a false change.
  const curUrl = cur.photo_url ?? null;
  const nextUrl = newUrl ?? null;
  if (curUrl === nextUrl) return { changed: false, reverified: false };

  const reverified = cur.is_verified === true;
  if (reverified) {
    await pool.query(
      'UPDATE users SET photo_url = $1, is_verified = FALSE, updated_at = NOW() WHERE id = $2',
      [nextUrl, userId],
    );
  } else {
    await pool.query(
      'UPDATE users SET photo_url = $1, updated_at = NOW() WHERE id = $2',
      [nextUrl, userId],
    );
  }
  return { changed: true, reverified };
}

module.exports = { applyPrimaryPhotoChange };
