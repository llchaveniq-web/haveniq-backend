// The free-tier daily connect quota, counted server-side.
//
// This replaced a counter in the app's premiumStore that lived in the device's
// SecureStore — on web, site data. Clearing it restored the allowance and a
// second browser was a second allowance, so the thing HavenIQ+ is sold to lift
// was not enforced anywhere a student could not reach.
//
// The atomic-spend test below is the one that matters. Reading the count and
// then writing it lets two taps a few milliseconds apart both read 4 of 5 and
// both write 5 — a sixth connect from a double tap on a slow connection.
const test = require('node:test');
const assert = require('node:assert');

// A tiny in-memory stand-in for the one statement the quota relies on, with
// the same semantics Postgres gives it: the DO UPDATE is refused when the
// stored value is already at the cap, and no row comes back.
const store = new Map();
let inFlight = 0, maxInFlight = 0;

const fakePool = {
  query: async (sql, params = []) => {
    if (sql.includes('SELECT used FROM connect_usage')) {
      const v = store.get(params[0]);
      return { rows: v === undefined ? [] : [{ used: v }] };
    }
    if (sql.includes('INSERT INTO connect_usage')) {
      const [userId, limit] = params;
      // Overlap the read and the write to prove the caller cannot interleave.
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setImmediate(r));
      try {
        const cur = store.get(userId);
        if (cur === undefined) { store.set(userId, 1); return { rows: [{ used: 1 }] }; }
        if (cur < limit) { store.set(userId, cur + 1); return { rows: [{ used: cur + 1 }] }; }
        return { rows: [] };                       // WHERE refused the update
      } finally { inFlight--; }
    }
    if (sql.includes('UPDATE connect_usage SET used = GREATEST')) {
      const cur = store.get(params[0]);
      if (cur !== undefined) store.set(params[0], Math.max(0, cur - 1));
      return { rows: [] };
    }
    return { rows: [] };
  },
};

const resolved = require.resolve('../db/pool');
require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: fakePool };

const q = require('./connectQuota');

test.beforeEach(() => { store.clear(); delete process.env.FREE_CONNECTS_PER_DAY; });

test('the limit is configurable, and a bad value never means unlimited', () => {
  delete process.env.FREE_CONNECTS_PER_DAY;
  assert.equal(q.dailyLimit(), q.DEFAULT_LIMIT);
  process.env.FREE_CONNECTS_PER_DAY = '3';     assert.equal(q.dailyLimit(), 3);
  process.env.FREE_CONNECTS_PER_DAY = '0';     assert.equal(q.dailyLimit(), 0);
  process.env.FREE_CONNECTS_PER_DAY = '9999';  assert.equal(q.dailyLimit(), 9999);
  // A typo must fall back, never give the product away.
  for (const bad of ['banana', '-1', '2.5', ' ']) {
    process.env.FREE_CONNECTS_PER_DAY = bad;
    assert.equal(q.dailyLimit(), q.DEFAULT_LIMIT, `${JSON.stringify(bad)} must fall back`);
  }
});

test('a free user spends down to the cap and is then refused', async () => {
  process.env.FREE_CONNECTS_PER_DAY = '3';
  for (let i = 1; i <= 3; i++) {
    const r = await q.spendConnect('u1', false);
    assert.equal(r.ok, true, `connect ${i} should be allowed`);
    assert.equal(r.used, i);
    assert.equal(r.remaining, 3 - i);
  }
  const over = await q.spendConnect('u1', false);
  assert.equal(over.ok, false);
  assert.equal(over.limit, 3);
  assert.equal(over.used, 3, 'the refusal reports the real count, not a guess');
});

test('premium is never counted at all', async () => {
  process.env.FREE_CONNECTS_PER_DAY = '1';
  for (let i = 0; i < 20; i++) {
    const r = await q.spendConnect('vip', true);
    assert.equal(r.ok, true);
  }
  assert.equal(store.get('vip'), undefined, 'no ledger row should exist for a premium user');
});

test('a limit of 0 refuses immediately', async () => {
  process.env.FREE_CONNECTS_PER_DAY = '0';
  const r = await q.spendConnect('u2', false);
  assert.equal(r.ok, false);
  assert.equal(r.limit, 0);
  assert.equal(store.get('u2'), undefined, 'a refusal must not create a row');
});

test('concurrent spends cannot exceed the cap — the double-tap race', async () => {
  process.env.FREE_CONNECTS_PER_DAY = '5';
  maxInFlight = 0;
  const results = await Promise.all(
    Array.from({ length: 20 }, () => q.spendConnect('racer', false)),
  );
  const granted = results.filter(r => r.ok).length;
  assert.equal(granted, 5, `exactly 5 connects may be granted, got ${granted}`);
  assert.equal(store.get('racer'), 5, 'the ledger must not overshoot the cap');
  assert.ok(maxInFlight > 1, 'the test must actually have overlapped calls to prove anything');
});

test('a refund gives a connect back and never goes negative', async () => {
  process.env.FREE_CONNECTS_PER_DAY = '2';
  await q.spendConnect('u3', false);
  assert.equal(store.get('u3'), 1);
  await q.refundConnect('u3');
  assert.equal(store.get('u3'), 0);
  await q.refundConnect('u3');
  assert.equal(store.get('u3'), 0, 'a double refund must not mint connects');
});

test('quotaFor reports what the app renders', async () => {
  process.env.FREE_CONNECTS_PER_DAY = '5';
  await q.spendConnect('u4', false);
  await q.spendConnect('u4', false);
  const free = await q.quotaFor('u4', false);
  assert.deepEqual(free, { limit: 5, used: 2, remaining: 3, unlimited: false });

  const paid = await q.quotaFor('u4', true);
  assert.equal(paid.unlimited, true);
  assert.equal(paid.remaining, null, 'unlimited must not render as a number');
});

test('remaining never goes negative if the cap is lowered under a user', async () => {
  // Set FREE_CONNECTS_PER_DAY=5, a student spends 5, then it is dropped to 2.
  process.env.FREE_CONNECTS_PER_DAY = '5';
  for (let i = 0; i < 5; i++) await q.spendConnect('u5', false);
  process.env.FREE_CONNECTS_PER_DAY = '2';
  const r = await q.quotaFor('u5', false);
  assert.equal(r.remaining, 0, 'must clamp at 0, not report -3');
});
