/**
 * Roommate vouches — the mutual, verified reputation layer
 * (docs/BACKEND_ROOMMATE_REPUTATION.md). Distinct from src/routes/vouches.js
 * (the public link, ANY ex-roommate, unverified testimonial system, which
 * still exists for its own ⭐ profile badge and is untouched here).
 *
 * What makes THIS one the real moat: both people must be real HavenIQ users
 * who actually matched/connected in the app (gated on connect_requests —
 * the same history mayViewMatchDetail in matches.js trusts), and it's a real
 * double opt-in: the FROM user submits a claim, but nothing counts toward
 * the ABOUT user's trust badge until the about_user explicitly confirms the
 * cohabitation happened. No stranger, no unverifiable claim, no forgery.
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
  ready = true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same real-match-history proof mayViewMatchDetail (matches.js) trusts — a
// connect_requests row in either direction, any status. This is the load-
// bearing check that makes the whole feature unfakeable: a stranger with no
// connect_requests history with the target can never create a row at all.
async function everConnected(userA, userB) {
  const { rows } = await pool.query(
    `SELECT 1 FROM connect_requests
      WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)
      LIMIT 1`,
    [userA, userB],
  );
  return rows.length > 0;
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

    if (!(await everConnected(fromUserId, aboutUserId))) {
      return res.status(403).json({ error: 'You can only vouch for someone you actually matched with on HavenIQ.' });
    }

    // Idempotent — a vouch is one per direction per pair (unique index).
    const existing = await pool.query(
      `SELECT id, status FROM roommate_vouches WHERE from_user_id = $1 AND about_user_id = $2`,
      [fromUserId, aboutUserId],
    );
    if (existing.rows[0]) {
      return res.json({ ok: true, id: existing.rows[0].id, status: existing.rows[0].status });
    }

    const { rows } = await pool.query(
      `INSERT INTO roommate_vouches (from_user_id, about_user_id, would_live_again, note)
       VALUES ($1, $2, $3, $4) RETURNING id, status`,
      [fromUserId, aboutUserId, wouldLiveAgain, note],
    );

    const sendPushToUser = req.app.get('sendPushToUser');
    if (sendPushToUser) {
      const senderName = req.user.first_name || 'A past roommate';
      sendPushToUser(aboutUserId, {
        title: 'You have a roommate vouch waiting ⭐',
        body: `${senderName} wants to vouch for living with you — confirm it to add it to your track record.`,
        data: { screen: 'circle' },
      }).catch(err => console.error('[push] roommate vouch request send failed:', err));
    }

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
    const confirmedAtClause = status === 'confirmed' ? ', confirmed_at = NOW()' : '';
    const { rows } = await pool.query(
      `UPDATE roommate_vouches SET status = $1${confirmedAtClause}
        WHERE id = $2 AND about_user_id = $3 AND status = 'pending'
        RETURNING from_user_id`,
      [status, id, String(req.user.id)],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });

    if (status === 'confirmed') {
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
