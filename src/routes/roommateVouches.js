/**
 * Roommate vouches — the mutual, verified reputation layer
 * (docs/BACKEND_ROOMMATE_REPUTATION.md). Distinct from src/routes/vouches.js
 * (the public link, ANY ex-roommate, unverified testimonial system, which
 * still exists for its own ⭐ profile badge and is untouched here).
 *
 * What makes THIS one the real moat: a request requires an actual
 * `moved_in_together` self-report already on file for the pair
 * (match_outcomes — the same table matchStore.js's markMovedIn() writes to,
 * and the same signal weightLearning/calibration train on), not merely that
 * the two matched or exchanged a connect request. A pair that only matched
 * or chatted — never recorded moving in — cannot create a row. And it's a
 * real double opt-in on top of that: the FROM user submits a claim, but
 * nothing counts toward the ABOUT user's trust badge until the about_user
 * explicitly confirms the cohabitation happened. No stranger, no thin
 * "we matched" claim, no forgery.
 *
 *   POST  /roommate-vouches/:aboutUserId/request     → create (auth; gated on real match history)
 *   GET   /roommate-vouches/me                       → my three lists (auth)
 *   POST  /roommate-vouches/:id/confirm               → about_user only (auth)
 *   POST  /roommate-vouches/:id/decline                → about_user only (auth)
 *   PATCH /roommate-vouches/:id/visibility             → about_user only, confirmed rows (auth)
 *
 * Visibility is per-vouch, default 'private' (docs §3: "default private, a
 * student chooses to make it public — never force-rated"). computeTrackRecord
 * (used by matches.js) only ever reads status='confirmed' AND
 * visibility='public' rows — a private confirmed vouch counts toward
 * nothing publicly visible until the about_user opts it in.
 */
const router  = require('express').Router();
const pool    = require('../db/pool');
const { requireAuth, refuseBanned } = require('../middleware/auth');
const { screenMessage } = require('../lib/contentFilter');
const { VOUCH_DECLINE_COOLDOWN_DAYS } = require('../lib/matchConfig');

let ready = false;
async function ensureTables() {
  if (ready) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS roommate_vouches (
      id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      from_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      about_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status           TEXT NOT NULL DEFAULT 'pending',   -- pending | confirmed | declined
      would_live_again BOOLEAN NOT NULL,
      note             TEXT,
      visibility       TEXT NOT NULL DEFAULT 'private',   -- public | private — about_user's call
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      confirmed_at     TIMESTAMPTZ
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_roommate_vouches_pair
    ON roommate_vouches (from_user_id, about_user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_roommate_vouches_about
    ON roommate_vouches (about_user_id, status)`);
  // declined_at mirrors confirmed_at — the timestamp of the LAST decline, so
  // a retry can tell "just declined" from "declined a month ago" instead of
  // falling back to created_at (which is the original ASK time, not the
  // decline time, and would start a mis-tap's cooldown clock before the
  // decline even happened).
  await pool.query(`ALTER TABLE roommate_vouches ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ`)
    .catch((e) => console.error('[roommate-vouches] add declined_at column:', e.message));
  ready = true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The load-bearing anti-forgery check: has EITHER side of this pair ever
// self-reported 'moved_in_together' for the other? Deliberately stronger
// than "they matched" or "a connect_requests row exists" — either of those
// is true for pairs who never actually lived together, which would let two
// merely-matched (or merely-friendly) real accounts fabricate a cohabitation
// claim. moved_in_together is the SAME event that schedules the day90/
// month6 retention check-ins (stores/matchStore.ts markMovedIn()) — every
// pair the check-in flywheel ever prompts already has this row, so
// tightening this gate never breaks that path, only the two manual entry
// points (thread + match-detail menus) that don't imply it on their own.
async function everMovedInTogether(userA, userB) {
  const { rows } = await pool.query(
    `SELECT 1 FROM match_outcomes
      WHERE outcome = 'moved_in_together'
        AND ((reporter_id = $1 AND other_user_id = $2) OR (reporter_id = $2 AND other_user_id = $1))
      LIMIT 1`,
    [userA, userB],
  );
  return rows.length > 0;
}

// The STRONGER bar: has EACH side independently self-reported
// 'moved_in_together' about the other? A unilateral report is enough to
// create a vouch request (everMovedInTogether above); this is the honest
// "ground truth" signal for anything that shouldn't rest on one person's
// unverified word alone — surfaced on match-detail (matches.js) so it can
// eventually feed the weight-learning training set the same way. Confirming
// a roommate vouch always produces this (see POST /:id/confirm above); pairs
// who never touch vouches get it only if both independently mark "we moved
// in" — which is why matchOutcomes.js nudges the second side to do so.
async function bothMovedInTogether(userA, userB) {
  const { rows } = await pool.query(
    `SELECT
       EXISTS(SELECT 1 FROM match_outcomes WHERE reporter_id = $1 AND other_user_id = $2 AND outcome = 'moved_in_together') AS a_reported,
       EXISTS(SELECT 1 FROM match_outcomes WHERE reporter_id = $2 AND other_user_id = $1 AND outcome = 'moved_in_together') AS b_reported`,
    [userA, userB],
  );
  return !!(rows[0]?.a_reported && rows[0]?.b_reported);
}

// The honest trust-badge aggregation, used by GET /matches/:userId
// (matches.js). Only status='confirmed' AND visibility='public' rows ever
// count — a pending or private-confirmed vouch is invisible here, matching
// "never force-rated, subject controls visibility".
async function computeTrackRecord(userId) {
  await ensureTables();
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS lived_with_count,
            COUNT(*) FILTER (WHERE would_live_again = TRUE)::int AS would_live_again_count
       FROM roommate_vouches
      WHERE about_user_id = $1 AND status = 'confirmed' AND visibility = 'public'`,
    [userId],
  );
  const livedWithCount      = countRows[0]?.lived_with_count ?? 0;
  const wouldLiveAgainCount = countRows[0]?.would_live_again_count ?? 0;
  if (livedWithCount === 0) return null;

  const { rows: quoteRows } = await pool.query(
    `SELECT rv.note, u.first_name, u.school_year
       FROM roommate_vouches rv
       JOIN users u ON u.id = rv.from_user_id
      WHERE rv.about_user_id = $1 AND rv.status = 'confirmed' AND rv.visibility = 'public'
        AND rv.would_live_again = TRUE
      ORDER BY rv.confirmed_at DESC
      LIMIT 5`,
    [userId],
  );

  const roommateWord = livedWithCount === 1 ? 'roommate' : 'roommates';
  const display = wouldLiveAgainCount > 0
    ? `Lived with ${livedWithCount} ${roommateWord} · ${wouldLiveAgainCount === livedWithCount ? (livedWithCount === 1 ? 'would live again' : 'all would live again') : `${wouldLiveAgainCount} would live again`}`
    : `Lived with ${livedWithCount} ${roommateWord}`;

  return {
    livedWithCount,
    wouldLiveAgainCount,
    display,
    vouches: quoteRows.map(r => ({
      fromFirstName: r.first_name || 'A former roommate',
      note: r.note || undefined,
      schoolYear: r.school_year || undefined,
    })),
  };
}

function rowForCaller(r, callerId) {
  const mine = r.from_user_id === callerId;
  return {
    id: r.id,
    otherUserId: mine ? r.about_user_id : r.from_user_id,
    otherFirstName: mine ? r.about_first_name : r.from_first_name,
    direction: mine ? 'sent' : 'received',
    status: r.status,
    wouldLiveAgain: r.would_live_again,
    note: r.note,
    visibility: r.visibility,
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
  };
}

// ── POST /roommate-vouches/:aboutUserId/request ─────────────────────────
router.post('/:aboutUserId/request', requireAuth, refuseBanned, async (req, res) => {
  try {
    await ensureTables();
    const fromUserId  = String(req.user.id);
    const aboutUserId = req.params.aboutUserId;
    if (!UUID_RE.test(aboutUserId)) return res.status(400).json({ error: 'invalid user id' });
    if (aboutUserId === fromUserId) return res.status(400).json({ error: "can't vouch for yourself" });

    const wouldLiveAgain = req.body?.wouldLiveAgain;
    if (typeof wouldLiveAgain !== 'boolean') {
      return res.status(400).json({ error: 'wouldLiveAgain (true/false) is required' });
    }
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 280) : null;
    if (note) {
      const screen = screenMessage(note);
      if (screen.action === 'block') {
        return res.status(422).json({ code: 'content_blocked', error: 'That note can’t be submitted.' });
      }
    }

    if (!(await everMovedInTogether(fromUserId, aboutUserId))) {
      return res.status(403).json({ error: "HavenIQ doesn't have a moved-in record for you two — mark that you moved in together first." });
    }

    const notifyAboutUser = () => {
      const sendPushToUser = req.app.get('sendPushToUser');
      if (!sendPushToUser) return;
      const senderName = req.user.first_name || 'A past roommate';
      sendPushToUser(aboutUserId, {
        title: 'You have a roommate vouch waiting ⭐',
        body: `${senderName} wants to vouch for living with you — confirm it to add it to your track record.`,
        data: { screen: 'circle' },
      }).catch(err => console.error('[push] roommate vouch request send failed:', err));
    };

    // A vouch is one per direction per pair (unique index) — a fresh INSERT
    // would violate it if a row already exists. pending/confirmed rows stay
    // exactly as before (idempotent no-op response). A DECLINED row used to
    // no-op the SAME way, forever — there was no path back, so a mis-tap
    // decline or a "not yet, ask me later" permanently ate the sender's one
    // shot, with the about_user never even seeing a second ask. Past
    // VOUCH_DECLINE_COOLDOWN_DAYS, this now revives the row instead:
    // pending again, with THIS attempt's would_live_again/note, and the
    // about_user gets notified again — same "revive, don't duplicate"
    // approach already used for connect_requests declines.
    const existing = await pool.query(
      `SELECT id, status, declined_at FROM roommate_vouches WHERE from_user_id = $1 AND about_user_id = $2`,
      [fromUserId, aboutUserId],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      const declineCooledDown = row.status === 'declined' && row.declined_at
        && (Date.now() - new Date(row.declined_at).getTime()) >= VOUCH_DECLINE_COOLDOWN_DAYS * 86400000;
      if (!declineCooledDown) {
        return res.json({ ok: true, id: row.id, status: row.status });
      }
      await pool.query(
        `UPDATE roommate_vouches
            SET status = 'pending', would_live_again = $1, note = $2,
                declined_at = NULL, confirmed_at = NULL, created_at = NOW()
          WHERE id = $3`,
        [wouldLiveAgain, note, row.id],
      );
      notifyAboutUser();
      return res.json({ ok: true, id: row.id, status: 'pending' });
    }

    const { rows } = await pool.query(
      `INSERT INTO roommate_vouches (from_user_id, about_user_id, would_live_again, note)
       VALUES ($1, $2, $3, $4) RETURNING id, status`,
      [fromUserId, aboutUserId, wouldLiveAgain, note],
    );

    notifyAboutUser();

    res.json({ ok: true, id: rows[0].id, status: rows[0].status });
  } catch (e) {
    console.error('[roommate-vouches/request]', e.message);
    res.status(500).json({ error: 'failed' });
  }
});

// ── GET /roommate-vouches/me ─────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const me = String(req.user.id);
    const { rows } = await pool.query(
      `SELECT rv.*, fu.first_name AS from_first_name, au.first_name AS about_first_name
         FROM roommate_vouches rv
         JOIN users fu ON fu.id = rv.from_user_id
         JOIN users au ON au.id = rv.about_user_id
        WHERE rv.from_user_id = $1 OR rv.about_user_id = $1
        ORDER BY rv.created_at DESC`,
      [me],
    );
    const mapped = rows.map(r => rowForCaller(r, me));
    res.json({
      // Requests about ME, awaiting my confirm/decline.
      pendingForMe: mapped.filter(r => r.direction === 'received' && r.status === 'pending'),
      // Vouches about ME that are confirmed — mine to make public/private.
      aboutMe: mapped.filter(r => r.direction === 'received' && r.status === 'confirmed'),
      // Vouches I sent, any status — for transparency only, no action here.
      sent: mapped.filter(r => r.direction === 'sent'),
    });
  } catch (e) {
    console.error('[roommate-vouches/me]', e.message);
    res.status(500).json({ error: 'failed' });
  }
});

// ── POST /roommate-vouches/:id/confirm | /decline — about_user only ──────
async function setStatus(req, res, status) {
  try {
    await ensureTables();
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
    const timestampClause = status === 'confirmed' ? ', confirmed_at = NOW()'
      : status === 'declined' ? ', declined_at = NOW()' : '';
    const { rows } = await pool.query(
      `UPDATE roommate_vouches SET status = $1${timestampClause}
        WHERE id = $2 AND about_user_id = $3 AND status = 'pending'
        RETURNING from_user_id`,
      [status, id, String(req.user.id)],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });

    if (status === 'confirmed') {
      // Confirming a vouch IS an explicit attestation "yes, we lived
      // together" — a stronger claim than the plain moved_in_together
      // self-report the request itself required. Best-effort: if the
      // about_user hasn't independently logged their own moved_in_together
      // report for this pair, stamp one now, so a confirmed vouch always
      // leaves the underlying match_outcomes ground truth mutually
      // corroborated (both directions present), not just the one-sided
      // report that was enough to CREATE the request.
      pool.query(
        `INSERT INTO match_outcomes (reporter_id, other_user_id, outcome, details)
         SELECT $1, $2, 'moved_in_together', $3
          WHERE NOT EXISTS (
            SELECT 1 FROM match_outcomes
             WHERE reporter_id = $1 AND other_user_id = $2 AND outcome = 'moved_in_together'
          )`,
        [String(req.user.id), rows[0].from_user_id, { source: 'roommate_vouch_confirm' }],
      ).catch(err => console.error('[roommate-vouches/confirm] moved-in corroboration insert failed:', err.message));

      const sendPushToUser = req.app.get('sendPushToUser');
      if (sendPushToUser) {
        const confirmerName = req.user.first_name || 'They';
        sendPushToUser(rows[0].from_user_id, {
          title: 'Your vouch was confirmed ⭐',
          body: `${confirmerName} confirmed your roommate vouch.`,
          data: { screen: 'circle' },
        }).catch(err => console.error('[push] roommate vouch confirm send failed:', err));
      }
    }
    res.json({ ok: true, status });
  } catch (e) {
    console.error('[roommate-vouches/setStatus]', e.message);
    res.status(500).json({ error: 'failed' });
  }
}
router.post('/:id/confirm', requireAuth, (req, res) => setStatus(req, res, 'confirmed'));
router.post('/:id/decline', requireAuth, (req, res) => setStatus(req, res, 'declined'));

// ── PATCH /roommate-vouches/:id/visibility — about_user only, confirmed ──
router.patch('/:id/visibility', requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
    const visibility = req.body?.visibility;
    if (visibility !== 'public' && visibility !== 'private') {
      return res.status(400).json({ error: "visibility must be 'public' or 'private'" });
    }
    const { rowCount } = await pool.query(
      `UPDATE roommate_vouches SET visibility = $1
        WHERE id = $2 AND about_user_id = $3 AND status = 'confirmed'`,
      [visibility, id, String(req.user.id)],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, visibility });
  } catch (e) {
    console.error('[roommate-vouches/visibility]', e.message);
    res.status(500).json({ error: 'failed' });
  }
});

module.exports = router;
module.exports.computeTrackRecord = computeTrackRecord;
module.exports.bothMovedInTogether = bothMovedInTogether;
