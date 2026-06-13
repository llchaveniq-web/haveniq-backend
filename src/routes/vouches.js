/**
 * Past-roommate vouches — the deepest social-proof moat in HavenIQ.
 *
 * A student invites a past roommate to write a one-sentence vouch. The
 * ex-roommate is NOT a HavenIQ user, so submission is PUBLIC (no auth):
 *
 *   GET  /vouches/target/:userId  → { firstName }            (public; greet the writer)
 *   POST /vouches/:userId {…}      → { ok, firstName }        (public; rate-limited + filtered)
 *   GET  /vouches/me               → { vouches: [...] }       (auth; the vouchee manages theirs)
 *   POST /vouches/:id/approve      → { ok }                   (auth; owner only)
 *   POST /vouches/:id/reject       → { ok }                   (auth; owner only)
 *   GET  /vouches/public/:userId   → { vouches: [...] }       (auth; APPROVED only, for display)
 *
 * Trust model — why a public write endpoint is safe here:
 *   • Every submission lands as status='pending'. NOTHING a stranger writes
 *     is ever shown publicly until the vouchee explicitly APPROVES it, so the
 *     public ⭐ trust signal can't be forged by an outsider.
 *   • Text is run through the same contentFilter as messages (slurs / threats
 *     / sexual content are blocked).
 *   • The public POST is IP-rate-limited, and we cap pending-per-user, so a
 *     bad actor can't flood someone's queue.
 *   • Self-migrating table; failures never touch other flows.
 */
const router    = require('express').Router();
const rateLimit = require('express-rate-limit');
const pool      = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { screenMessage } = require('../lib/contentFilter');

let ready = false;
async function ensureTables() {
  if (ready) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vouches (
      id           BIGSERIAL PRIMARY KEY,
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- the vouchee
      from_name    TEXT NOT NULL,
      relationship TEXT,
      text         TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vouches_user ON vouches (user_id, status)`);
  ready = true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PENDING_PER_USER = 30; // anti-flood: cap unreviewed vouches per vouchee

function clean(s, max) {
  return typeof s === 'string' ? s.trim().slice(0, max) : '';
}

// Public submit is the only abuse surface — limit per IP.
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 8,                    // 8 vouch submissions/hour/IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again later.' },
});

// ── GET /vouches/target/:userId — public; lets the writer see whose vouch
//    they're filling out. Returns ONLY the first name (no other PII).
router.get('/target/:userId', async (req, res) => {
  try {
    await ensureTables();
    const userId = req.params.userId;
    if (!UUID_RE.test(userId)) return res.status(404).json({ error: 'not found' });
    const { rows } = await pool.query('SELECT first_name FROM users WHERE id = $1', [userId]);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ firstName: rows[0].first_name || 'your roommate' });
  } catch (e) {
    console.error('[vouches/target]', e.message);
    res.status(500).json({ error: 'failed' });
  }
});

// ── POST /vouches/:userId — public submission. Held as pending.
router.post('/:userId', submitLimiter, async (req, res) => {
  try {
    await ensureTables();
    const userId = req.params.userId;
    if (!UUID_RE.test(userId)) return res.status(404).json({ error: 'not found' });

    const target = await pool.query('SELECT first_name FROM users WHERE id = $1', [userId]);
    if (!target.rows[0]) return res.status(404).json({ error: 'not found' });

    const fromName     = clean(req.body?.fromName, 60);
    const relationship = clean(req.body?.relationship, 80);
    const text         = clean(req.body?.text, 280);
    if (fromName.length < 1)  return res.status(400).json({ error: 'Please add your name.' });
    if (text.length < 10)     return res.status(400).json({ error: 'Please write at least a sentence.' });

    // Same content gate as messaging — block slurs / threats / sexual content.
    const screen = screenMessage(`${fromName} ${relationship} ${text}`);
    if (screen.action === 'block') {
      return res.status(422).json({ code: 'content_blocked', error: 'That message can’t be submitted.' });
    }

    // Anti-flood: cap unreviewed vouches per vouchee.
    const pending = await pool.query(
      `SELECT COUNT(*)::int AS n FROM vouches WHERE user_id = $1 AND status = 'pending'`, [userId]);
    if ((pending.rows[0]?.n ?? 0) >= MAX_PENDING_PER_USER) {
      return res.status(429).json({ error: 'This person has too many pending vouches right now.' });
    }

    await pool.query(
      `INSERT INTO vouches (user_id, from_name, relationship, text, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [userId, fromName, relationship || null, text]);

    res.json({ ok: true, firstName: target.rows[0].first_name || 'your roommate' });
  } catch (e) {
    console.error('[vouches/submit]', e.message);
    res.status(500).json({ error: 'failed' });
  }
});

// ── GET /vouches/me — the vouchee's own list (all statuses), for managing.
router.get('/me', requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const { rows } = await pool.query(
      `SELECT id, from_name, relationship, text, status, created_at
         FROM vouches WHERE user_id = $1 ORDER BY created_at DESC`,
      [String(req.user.id)]);
    res.json({ vouches: rows });
  } catch (e) {
    console.error('[vouches/me]', e.message);
    res.status(500).json({ error: 'failed' });
  }
});

// ── POST /vouches/:id/approve | /reject — owner only.
async function setStatus(req, res, status) {
  try {
    await ensureTables();
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    const { rowCount } = await pool.query(
      `UPDATE vouches SET status = $1 WHERE id = $2 AND user_id = $3 AND status = 'pending'`,
      [status, id, String(req.user.id)]);
    if (rowCount === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[vouches/setStatus]', e.message);
    res.status(500).json({ error: 'failed' });
  }
}
router.post('/:id/approve', requireAuth, (req, res) => setStatus(req, res, 'approved'));
router.post('/:id/reject',  requireAuth, (req, res) => setStatus(req, res, 'rejected'));

// ── GET /vouches/public/:userId — APPROVED only, for profile/match-card display.
router.get('/public/:userId', requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const userId = req.params.userId;
    if (!UUID_RE.test(userId)) return res.status(404).json({ error: 'not found' });
    const { rows } = await pool.query(
      `SELECT id, from_name, relationship, text, created_at
         FROM vouches WHERE user_id = $1 AND status = 'approved' ORDER BY created_at DESC`,
      [userId]);
    res.json({ vouches: rows });
  } catch (e) {
    console.error('[vouches/public]', e.message);
    res.status(500).json({ error: 'failed' });
  }
});

module.exports = router;
