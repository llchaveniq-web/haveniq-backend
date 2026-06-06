/**
 * Referral attribution — unique per-user invite codes + who-referred-whom.
 *
 *   GET  /referrals/my-code         → { code }      (lazily allocates a unique code)
 *   GET  /referrals/me              → { code, count }
 *   POST /referrals/attribute {code}→ { attributed, reason? }
 *
 * Deliberately DECOUPLED from the auth/signup flow: the client fires
 * /attribute AFTER a successful signup (fire-and-forget), so a failure here
 * can never block or break a student signing up. Self-migrating tables.
 */
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

let ready = false;
async function ensureTables() {
  if (ready) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_codes (
      user_id    TEXT PRIMARY KEY,
      code       TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referrals (
      id          BIGSERIAL PRIMARY KEY,
      referrer_id TEXT NOT NULL,
      referred_id TEXT UNIQUE NOT NULL,   -- one referrer per referred user
      code        TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_id)`);
  ready = true;
}

// Ambiguous-char-free alphabet (no 0/O/1/I/L) so codes are easy to read/type.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `HAVEN-${s}`;
}

async function getOrCreateCode(uid) {
  const existing = await pool.query('SELECT code FROM referral_codes WHERE user_id = $1', [uid]);
  if (existing.rows[0]) return existing.rows[0].code;
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = genCode();
    try {
      await pool.query('INSERT INTO referral_codes (user_id, code) VALUES ($1, $2)', [uid, code]);
      return code;
    } catch (e) {
      if (e.code === '23505') {
        // Either the code collided or this user got a row from a concurrent
        // request. Re-check the user's row; if present, use it.
        const after = await pool.query('SELECT code FROM referral_codes WHERE user_id = $1', [uid]);
        if (after.rows[0]) return after.rows[0].code;
        continue; // code collision — try a new code
      }
      throw e;
    }
  }
  return null;
}

// GET /referrals/my-code
router.get('/my-code', requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const code = await getOrCreateCode(String(req.user.id));
    if (!code) return res.status(500).json({ error: 'could not allocate code' });
    res.json({ code });
  } catch (e) {
    console.error('[referrals/my-code]', e.message);
    res.status(500).json({ error: 'failed' });
  }
});

// GET /referrals/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const uid = String(req.user.id);
    const code = await getOrCreateCode(uid);
    const countRow = await pool.query('SELECT COUNT(*)::int AS n FROM referrals WHERE referrer_id = $1', [uid]);
    res.json({ code, count: countRow.rows[0]?.n ?? 0 });
  } catch (e) {
    console.error('[referrals/me]', e.message);
    res.status(500).json({ error: 'failed' });
  }
});

// POST /referrals/attribute { code }
// Fired by the client right after a NEW user signs up. Idempotent + guarded:
// unknown code, self-referral, and already-attributed all no-op cleanly.
router.post('/attribute', requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
    if (!code) return res.status(400).json({ error: 'code required' });
    const uid = String(req.user.id);

    const ref = await pool.query('SELECT user_id FROM referral_codes WHERE code = $1', [code]);
    const referrerId = ref.rows[0]?.user_id;
    if (!referrerId) return res.json({ attributed: false, reason: 'unknown_code' });
    if (referrerId === uid) return res.json({ attributed: false, reason: 'self' });

    try {
      await pool.query(
        'INSERT INTO referrals (referrer_id, referred_id, code) VALUES ($1, $2, $3)',
        [referrerId, uid, code],
      );
      return res.json({ attributed: true });
    } catch (e) {
      if (e.code === '23505') return res.json({ attributed: false, reason: 'already_attributed' });
      throw e;
    }
  } catch (e) {
    console.error('[referrals/attribute]', e.message);
    res.status(500).json({ error: 'failed' });
  }
});

module.exports = router;
