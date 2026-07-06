// Verify the two Grow-loop manual triggers on production.
//
// Run it so Railway injects the real env (JWT_SECRET + FOUNDER_*):
//   railway run node scripts/verify-grow-triggers.js
//
// It mints a short-lived (10-min) founder JWT, POSTs both /ops triggers on
// production, and prints the exact HTTP status + JSON each returns. No secret
// ever leaves your machine; nothing to copy/paste back and forth.
const jwt = require('jsonwebtoken');
const { getFounderEmails, getFounderIds } = require('../src/utils/founders');
const BASE = process.env.VERIFY_BASE || 'https://haveniq-backend-production.up.railway.app';

(async () => {
  if (!process.env.JWT_SECRET) {
    console.error('No JWT_SECRET in env. Run me via `railway run node scripts/verify-grow-triggers.js` so Railway injects it.');
    process.exit(1);
  }

  // Prefer the real founder account id. Try the DB (by FOUNDER_EMAILS); if the
  // DB isn't reachable from your laptop (Railway internal host), fall back to
  // FOUNDER_USER_IDS[0] from the injected env.
  let id = getFounderIds()[0];
  try {
    const pool = require('../src/db/pool');
    const r = await pool.query('SELECT id, email FROM users WHERE email = ANY($1)', [getFounderEmails()]);
    if (r.rows[0]) { id = r.rows[0].id; console.log('founder account (from DB):', r.rows[0].email, id); }
    else console.log('no founder row matched FOUNDER_EMAILS; using FOUNDER_USER_IDS[0]:', id);
  } catch (e) {
    console.log('DB lookup skipped (', e.message, ') — using FOUNDER_USER_IDS[0]:', id);
  }

  const token = jwt.sign({ userId: id }, process.env.JWT_SECRET, { expiresIn: '10m' });

  for (const path of ['/ops/growth-digest/run', '/ops/lifecycle/run']) {
    try {
      const res = await fetch(BASE + path, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const text = await res.text();
      console.log(`\n=== POST ${path} -> HTTP ${res.status} ===`);
      try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }
    } catch (e) {
      console.log(`\n=== POST ${path} -> request failed: ${e.message} ===`);
    }
  }
  process.exit(0);
})();
