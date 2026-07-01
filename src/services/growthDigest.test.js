// Tests for the weekly growth digest. Pure helpers + orchestrator (fake pool /
// draft / email). No DB, no network, no LLM. node --test.
const test = require('node:test');
const assert = require('node:assert');
const gd = require('./growthDigest');

// ── weeklyDelta: honesty gate ───────────────────────────────────────────────
test('weeklyDelta: computes delta + pctChange when the cohort is big enough', () => {
  const d = gd.weeklyDelta(30, 20, 20);
  assert.equal(d.enoughData, true);
  assert.equal(d.delta, 10);
  assert.equal(d.pctChange, 50);
});

test('weeklyDelta: thin cohort → enoughData false (not enough data yet)', () => {
  const d = gd.weeklyDelta(5, 3, 20);
  assert.equal(d.enoughData, false);
});

test('weeklyDelta: last=0 → pctChange null (no divide-by-zero, no fake %)', () => {
  const d = gd.weeklyDelta(25, 0, 20);
  assert.equal(d.pctChange, null);
  assert.equal(d.delta, 25);
});

// ── computeFunnelDrops ──────────────────────────────────────────────────────
test('computeFunnelDrops: finds the biggest TRUSTED drop', () => {
  const funnel = [
    { stage: 'signup', count: 100 },
    { stage: 'quiz', count: 40 },     // 60% drop — biggest, cohort 100 (trusted)
    { stage: 'match', count: 35 },
    { stage: 'connect', count: 20 },
    { stage: 'invite', count: 5 },    // 75% drop but from cohort 20 (== floor, trusted)
  ];
  const { drops, biggestDrop } = gd.computeFunnelDrops(funnel, 20);
  assert.equal(drops.length, 4);
  // connect→invite is 75% (from 20 >= 20 floor) → the biggest trusted drop
  assert.equal(biggestDrop.from, 'connect');
  assert.equal(biggestDrop.to, 'invite');
  assert.equal(biggestDrop.dropPct, 75);
});

test('computeFunnelDrops: thin stages are not trusted → biggestDrop null', () => {
  const funnel = [
    { stage: 'signup', count: 10 }, { stage: 'quiz', count: 2 },
    { stage: 'match', count: 1 }, { stage: 'connect', count: 0 }, { stage: 'invite', count: 0 },
  ];
  const { biggestDrop } = gd.computeFunnelDrops(funnel, 20);
  assert.equal(biggestDrop, null);   // nothing has enough data → no drop claimed
});

// ── templateNarrative: uses only given numbers, flags thin cohorts ──────────
test('templateNarrative: quotes real deltas and says "not enough data yet" for thin ones', () => {
  const metrics = {
    weekly: {
      signups: gd.weeklyDelta(30, 20, 20),          // enough
      quizCompletions: gd.weeklyDelta(4, 2, 20),    // thin
      connects: gd.weeklyDelta(25, 25, 20),
      referrals: gd.weeklyDelta(1, 0, 20),          // thin
    },
    biggestDrop: { from: 'quiz', to: 'match', fromCount: 30, toCount: 10, dropPct: 66.7 },
  };
  const text = gd.templateNarrative(metrics);
  assert.ok(text.includes('30 this week vs 20 last'));      // real numbers, verbatim
  assert.ok(text.includes('not enough data yet'));          // thin cohort flagged
  assert.ok(text.includes('quiz → match'));                 // biggest drop named
  assert.ok(/Suggested experiments:/.test(text));           // 2-3 experiments present
});

// ── runDigest orchestrator ──────────────────────────────────────────────────
function makePool(funnelRow) {
  const inserts = [];
  const pool = {
    inserts,
    query: async (sql, params = []) => {
      if (sql.includes('CREATE TABLE')) return { rows: [] };
      if (sql.includes('COUNT(*)::int AS signups')) return { rows: [funnelRow] };
      if (sql.includes('_this') || sql.includes('INTERVAL')) return { rows: [{}] }; // weekly windows → 0s
      if (sql.includes('INSERT INTO growth_digests')) { inserts.push({ metrics: JSON.parse(params[0]), narrative: params[1], source: params[2], to: params[3] }); return { rows: [] }; }
      if (sql.includes('FROM growth_digests')) return { rows: [] };
      return { rows: [] };
    },
  };
  return pool;
}

test('runDigest: kill switch OFF → skipped, no email, nothing stored', async () => {
  const pool = makePool({ signups: 50, quiz: 40, match: 30, connect: 20, invite: 5 });
  let emails = 0;
  const r = await gd.runDigest({ enabled: false, pool, sendEmail: async () => { emails++; }, draft: async () => ({ narrative: 'x', source: 'template' }) });
  assert.equal(r.enabled, false);
  assert.equal(r.skipped, 'disabled');
  assert.equal(emails, 0);
  assert.equal(pool.inserts.length, 0);
});

test('runDigest: enabled → collects real numbers, drafts, stores, emails founder', async () => {
  const pool = makePool({ signups: 50, quiz: 40, match: 30, connect: 20, invite: 5 });
  const emails = [];
  // The draft fn only receives metrics — it cannot invent numbers; assert the
  // funnel it is handed is exactly the DB row.
  let handed = null;
  const r = await gd.runDigest({
    enabled: true, pool,
    config: { minCohort: 20, email: 'founder@haveniq.org' },
    draft: async (m) => { handed = m; return { narrative: 'ok', source: 'template' }; },
    sendEmail: async (m) => { emails.push(m); },
  });
  assert.equal(r.enabled, true);
  assert.equal(r.emailed, true);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, 'founder@haveniq.org');
  assert.equal(pool.inserts.length, 1);
  assert.deepEqual(handed.funnel.map((s) => s.count), [50, 40, 30, 20, 5]); // real, unmodified
  assert.equal(handed.biggestDrop.from, 'connect');                         // 20→5 = 75%, the biggest
});

test('runDigest: an email failure still stores the digest (informational, durable)', async () => {
  const pool = makePool({ signups: 50, quiz: 40, match: 30, connect: 20, invite: 5 });
  const r = await gd.runDigest({
    enabled: true, pool, config: { minCohort: 20, email: 'f@x.org' },
    draft: async () => ({ narrative: 'ok', source: 'template' }),
    sendEmail: async () => { throw new Error('resend down'); },
  });
  assert.equal(r.emailed, false);
  assert.equal(pool.inserts.length, 1);   // stored despite the email failing
});
