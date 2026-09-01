// ── Free-tier connect quota, counted per day, on the server ─────────────────
//
// A free student gets FREE_CONNECTS_PER_DAY connect requests. HavenIQ+ lifts
// the cap. The count resets at midnight (the database's date, see below).
//
// ── Why this moved out of the app ──
//
// The cap lived in stores/premiumStore.ts as `connectsUsed`, persisted to the
// device's SecureStore. On the web that is site data: clear it and the
// allowance comes back, and a second browser is a second allowance. The thing
// HavenIQ+ is sold to lift was not enforced anywhere a student could not reach.
//
// ── Why a ledger and not a COUNT of connect_requests ──
//
// connect_requests is UNIQUE(from_user, to_user), and a re-send after the
// decline cooldown UPDATEs that row instead of inserting. created_at is
// therefore the FIRST time those two were introduced, not the latest — so
// counting it would under-count precisely the students who use the app most.
//
// ── Daily, not lifetime ──
//
// A lifetime cap is a one-time trigger dressed as a subscription: once bought,
// the wall it removed never returns, so month two feels like paying for
// nothing. A daily allowance regenerates the reason to pay, and it stops the
// wall landing in session two before the product has proven anything.

const pool = require('../db/pool');

/** Default free connects per day. Chosen to be felt by a student searching
 *  hard and invisible to one browsing casually. */
const DEFAULT_LIMIT = 5;

/**
 * Connects a free account may send per day.
 *
 * Set FREE_CONNECTS_PER_DAY in Railway to change it with no deploy. The value
 * IS the cap: 3 means three a day, 0 means the paywall is immediate. To turn
 * the cap off entirely, set it high (9999) rather than to 0 — "zero free
 * connects" is what 0 honestly reads as, and a flag that means its own
 * opposite is how a launch-night change goes in backwards.
 *
 * A non-numeric or negative value falls back to the default rather than
 * silently becoming unlimited: a typo in an env var must never quietly
 * give away the product.
 */
function dailyLimit() {
  // Trimmed before anything else. Number(' ') is 0, not NaN, so a stray space
  // in the Railway field — the easiest possible typo, and invisible in the UI —
  // would otherwise read as a deliberate "zero free connects" and paywall every
  // student on the platform. Caught by this module's own test.
  const raw = (process.env.FREE_CONNECTS_PER_DAY ?? '').trim();
  if (raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_LIMIT;
  return n;
}

/** Today's usage for a user, without changing it. */
async function usedToday(userId) {
  const { rows } = await pool.query(
    'SELECT used FROM connect_usage WHERE user_id = $1 AND day = CURRENT_DATE',
    [userId],
  );
  return rows[0] ? Number(rows[0].used) : 0;
}

/**
 * Quota state for the premium status endpoint, so the app can render
 * "2 of 5 left today" from the server's numbers rather than its own.
 */
async function quotaFor(userId, isPremium) {
  const limit = dailyLimit();
  if (isPremium) return { limit: null, used: 0, remaining: null, unlimited: true };
  const used = await usedToday(userId);
  return { limit, used, remaining: Math.max(0, limit - used), unlimited: false };
}

/**
 * Spend one connect. Returns { ok: true, used, remaining } or
 * { ok: false, limit, used } when the day's allowance is gone.
 *
 * The check and the increment are ONE statement on purpose. Reading the count
 * and then writing it would let two taps a few milliseconds apart both read 4
 * of 5 and both write 5, handing out a sixth connect — the classic
 * check-then-act race, and an easy one to hit with a double tap on a slow
 * connection. The WHERE on the DO UPDATE makes the database refuse the
 * increment instead: over the limit, no row comes back.
 */
async function spendConnect(userId, isPremium) {
  if (isPremium) return { ok: true, unlimited: true };

  const limit = dailyLimit();
  if (limit <= 0) return { ok: false, limit, used: 0 };

  const { rows } = await pool.query(
    `INSERT INTO connect_usage (user_id, day, used)
          VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (user_id, day) DO UPDATE
            SET used = connect_usage.used + 1
          WHERE connect_usage.used < $2
      RETURNING used`,
    [userId, limit],
  );

  if (!rows[0]) {
    // The conflict path was refused, so the row is already at the cap.
    return { ok: false, limit, used: await usedToday(userId) };
  }
  const used = Number(rows[0].used);
  return { ok: true, limit, used, remaining: Math.max(0, limit - used) };
}

/** Give a spent connect back — used when the write it was spent on fails. */
async function refundConnect(userId) {
  await pool.query(
    `UPDATE connect_usage SET used = GREATEST(0, used - 1)
      WHERE user_id = $1 AND day = CURRENT_DATE`,
    [userId],
  );
}

module.exports = { dailyLimit, usedToday, quotaFor, spendConnect, refundConnect, DEFAULT_LIMIT };
