/**
 * Pre-match photo gallery — the shared SQL + shaping for "up to N photos".
 *
 * PRODUCT CHANGE (owner decision, 2026-07-22): faces are now visible while
 * CHOOSING a match — the deck, fit report, daily pick and search — not only
 * after a mutual match. This reverses the earlier pre-match face-hide
 * (utils/photoReveal.ts in the app, which still documents the old thesis).
 *
 * One helper rather than four copies of the same LATERAL join: the previous
 * duplication of an auth check across five route files is exactly how these
 * drift (see middleware/requireInternalKey.js).
 *
 * Ordering is `position ASC` — the same order the owner set in their photo
 * manager, so the face they chose to lead with leads here too.
 */

// The app reveals at most 4 (REVEAL_PHOTO_COUNT in utils/photoReveal.ts), even
// though storage allows 6. Capping in SQL keeps the payload small and means a
// user who uploaded 6 doesn't silently ship two extra images to every viewer.
const MAX_FEED_PHOTOS = 4;

/**
 * A LATERAL join yielding `<alias>.urls` — an ordered text[] of up to
 * MAX_FEED_PHOTOS gallery urls for the user in `userExpr`.
 *
 * `userExpr` is interpolated, so pass a COLUMN REFERENCE you control
 * (e.g. 'u.id'), never user input.
 */
function galleryJoin(userExpr = 'u.id', alias = 'ph') {
  return `
      LEFT JOIN LATERAL (
        SELECT array_agg(p.url ORDER BY p.position) AS urls
          FROM (
            SELECT url, position FROM user_photos
             WHERE user_id = ${userExpr} AND url IS NOT NULL AND btrim(url) <> ''
             ORDER BY position ASC
             LIMIT ${MAX_FEED_PHOTOS}
          ) p
      ) ${alias} ON TRUE`;
}

/**
 * Build the client-facing `photos` array for one row.
 *
 * Falls back to the single `photo_url` when the gallery is empty, so a user who
 * never used the multi-photo manager still shows their one face. Returns [] when
 * there is nothing — never a placeholder, never a fabricated image.
 */
function photosFor(row, alias = 'photo_urls') {
  const gallery = Array.isArray(row?.[alias]) ? row[alias].filter(Boolean) : [];
  if (gallery.length) return gallery.slice(0, MAX_FEED_PHOTOS);
  const single = typeof row?.photo_url === 'string' && row.photo_url.trim() ? row.photo_url : null;
  return single ? [single] : [];
}

module.exports = { galleryJoin, photosFor, MAX_FEED_PHOTOS };
