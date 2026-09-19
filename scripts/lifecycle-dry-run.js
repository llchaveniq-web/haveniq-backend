// Read only preview of the next lifecycle (nudge email) run. Sends nothing,
// writes nothing. Runs the job's own segment SQL and prints who would get
// which email, plus the circuit breaker verdict.
//
//   DATABASE_URL=... node scripts/lifecycle-dry-run.js
const { Pool } = require('pg');
const { SEGMENTS, ACTIVE_USERS_SQL, dedupByPriority, circuitBreaker } = require('../src/services/lifecycleSegments');
const { isDemoEmail } = require('../src/lib/demoFilter');
const { cfg } = require('../src/services/lifecycleSender');

(async () => {
  const c = cfg();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    // lifecycle_sends may not exist if the job never ran; the segment SQL needs it.
    const t = await pool.query("SELECT to_regclass('lifecycle_sends') AS t");
    if (!t.rows[0].t) { console.log('lifecycle_sends does not exist yet; the first real run creates it.'); return; }

    const active = (await pool.query(ACTIVE_USERS_SQL, [c.activeWindow])).rows[0].n;
    const bySegment = [];
    for (const s of SEGMENTS) {
      const r = await pool.query(s.sql, [c.cooldownDays]);
      bySegment.push({ segmentId: s.id, templateId: s.templateId, recipients: r.rows });
    }
    const planned = dedupByPriority(bySegment).filter((p) => p.email && !isDemoEmail(p.email));
    const b = circuitBreaker(planned.length, active, c.maxFraction, c.minAbs);

    console.log(`active students: ${active} | would send: ${planned.length} | cap: ${b.threshold} | ${b.trip ? 'PAUSED (breaker trips, nothing sent)' : 'would send'}`);
    for (const p of planned) {
      const u = (await pool.query('SELECT created_at, last_active_at FROM users WHERE id = $1', [p.userId])).rows[0] || {};
      const d = (x) => (x ? new Date(x).toISOString().slice(0, 10) : 'never');
      console.log(`  ${p.segmentId.padEnd(16)} ${p.email.padEnd(36)} joined ${d(u.created_at)}  last seen ${d(u.last_active_at)}`);
    }

    const flagged = (await pool.query('SELECT email FROM users WHERE is_demo = TRUE ORDER BY email')).rows.map((r) => r.email);
    console.log(`\nflagged as demo (excluded): ${flagged.length ? flagged.join(', ') : 'none'}`);
    const last = (await pool.query('SELECT MAX(sent_at) AS at, COUNT(*)::int AS n FROM lifecycle_sends')).rows[0];
    console.log(`past lifecycle sends: ${last.n}, most recent ${last.at ? new Date(last.at).toISOString() : 'never'}`);
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
