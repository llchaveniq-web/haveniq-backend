// Faces stay hidden until a mutual match, and the SERVER enforces it.
//
// The app's policy (utils/photoReveal.ts in haveniq-app) is that no pre match
// surface shows a face: the deck, the fit report, the daily pick, compare,
// search. Until 2026-09-21 that was true only on screen. /matches/feed, the
// single match profile, match of the day and others sent every candidate's
// photo URLs to the phone and the app painted a gradient over them, so anyone
// who opened the network tab saw the faces the product says are private.
// Jackson asked for the server to enforce it.
//
// Rule: another student's photos go only to someone with an ACCEPTED connect
// request with them, in either direction. The same relationship the rest of
// the backend calls connected (areConnected in userPhotos.js and friends).

const poolDefault = require('../db/pool');

/**
 * The subset of `ids` that `viewerId` is connected to. One query, any size.
 * Soft-fails to an empty set, which errs toward hiding a photo, never showing.
 */
async function connectedSet(viewerId, ids, pool = poolDefault) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!viewerId || list.length === 0) return new Set();
  try {
    const { rows } = await pool.query(
      `SELECT CASE WHEN from_user = $1 THEN to_user ELSE from_user END AS other
         FROM connect_requests
        WHERE status = 'accepted'
          AND ((from_user = $1 AND to_user = ANY($2::uuid[]))
            OR (to_user = $1 AND from_user = ANY($2::uuid[])))`,
      [viewerId, list],
    );
    return new Set(rows.map((r) => String(r.other)));
  } catch (e) {
    console.warn('[photoGate] connectedSet failed, hiding photos:', e.message);
    return new Set();
  }
}

module.exports = { connectedSet };
