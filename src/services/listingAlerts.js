/**
 * Listing alerts — "tell me when a place near me shows up".
 *
 * SpareRoom's saved-search alert is the one retention loop HavenIQ had no
 * answer to: a new listing that matches your criteria pushes you, and you come
 * back. The push infrastructure already existed here (server.js sendPushToUser,
 * push_tokens) and was used only for messages; this puts it behind housing.
 *
 * TWO honest constraints shape this file:
 *
 *   1. Listings are founder-curated (POST /housing/listings is isFounder-gated),
 *      so this fires when a listing is ADDED, not continuously. That's a real
 *      ceiling on the loop's frequency and it isn't worth pretending otherwise
 *      — but "we added a place near you, under your budget" is exactly the
 *      moment worth interrupting someone for, and it costs nothing when idle.
 *
 *   2. Push never reaches web users, and web is the launch funnel. messages.js
 *      already learned this and pairs every push with an email. So does this:
 *      the email is the primary channel here, not the fallback.
 *
 * Everything is fire-and-forget from the route. A listing must still be created
 * successfully if Resend is down or a push token is stale.
 */

const pool = require('../db/pool');
const { sendListingAlertEmail } = require('./email');

/** Dollars for display, from the integer cents the listings table stores. */
function dollars(cents) {
  return Math.round(Number(cents) / 100);
}

/**
 * Everyone whose active alert this listing satisfies.
 *
 * Filters are AND-ed and each one is OPTIONAL: a NULL max budget or min-beds
 * means "no opinion", not "matches nothing". The creator is excluded — the
 * founder posting a listing should not be pushed about their own post.
 *
 * Exported for tests: the SQL is the whole feature, and it's the part that can
 * silently over-notify (spamming people) or under-notify (a dead feature that
 * looks fine).
 */
async function findMatchingAlerts(listing) {
  const { rows } = await pool.query(
    `SELECT la.user_id, u.email, u.first_name
       FROM listing_alerts la
       JOIN users u ON u.id = la.user_id
      WHERE la.is_active = TRUE
        AND la.school_near = $1
        AND ($2::uuid IS NULL OR la.user_id <> $2::uuid)
        AND (la.max_per_person_cents IS NULL OR $3::int <= la.max_per_person_cents)
        AND (la.min_beds IS NULL OR $4::int >= la.min_beds)
        AND u.is_banned = FALSE`,
    [
      listing.school_near,
      listing.created_by ?? null,
      listing.per_person_rent_cents,
      listing.beds,
    ],
  );
  return rows;
}

/**
 * Notify everyone watching for a listing like this one.
 *
 * Never throws: called fire-and-forget from the create route, where a failed
 * notification must not fail the listing.
 */
async function notifyNewListing(listing, sendPushToUser) {
  try {
    const targets = await findMatchingAlerts(listing);
    if (!targets.length) return { notified: 0 };

    const perPerson = dollars(listing.per_person_rent_cents);
    const where = listing.city ? `${listing.city}` : listing.school_near;
    const title = `New place near ${where}`;
    const body = `$${perPerson}/mo per person · ${listing.beds} bed${listing.beds === 1 ? '' : 's'}`;

    await Promise.allSettled(targets.map(async (t) => {
      if (sendPushToUser) {
        // data.screen lets the app deep-link straight to the listing rather
        // than dumping the student on a browse screen to find it again.
        await sendPushToUser(t.user_id, {
          title,
          body,
          data: { screen: 'housing-browser', listingId: listing.id },
        }).catch(() => {});
      }
      if (t.email) {
        await sendListingAlertEmail({
          toEmail:   t.email,
          toName:    t.first_name || 'there',
          perPerson,
          beds:      listing.beds,
          address:   listing.address,
          city:      listing.city,
          userId:    t.user_id,
        }).catch(() => {});
      }
    }));

    await pool.query(
      `UPDATE listing_alerts SET last_notified_at = now() WHERE user_id = ANY($1::uuid[])`,
      [targets.map(t => t.user_id)],
    ).catch(() => {});

    return { notified: targets.length };
  } catch (err) {
    console.error('[listingAlerts] notify failed:', err.message);
    return { notified: 0, error: err.message };
  }
}

module.exports = { findMatchingAlerts, notifyNewListing, dollars };
