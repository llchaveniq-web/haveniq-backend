// The realized referral loop: the arithmetic, and the case where the table the
// whole metric reads does not exist yet.
//
// The SQL itself is exercised against a real Postgres, not here — a stubbed
// pool cannot tell a correct query from a wrong one. What this file covers is
// what JS decides: the k denominator, the small-sample suppression, and the
// fallback that keeps /admin/metrics alive before anyone has ever generated a
// referral code.
const test = require('node:test');
const assert = require('node:assert');
const {
  shapeReferralLoop, fetchReferralLoop, K_MIN_COHORT,
  REFERRAL_LOOP_SQL, CAMPUS_ONLY_SQL,
} = require('./referralLoop');

test('k counts new pool members against the students who were already there', () => {
  // 14 quiz-complete on campus, 3 of whom a referral brought in. The 11 who
  // were already there are the ones who could have done the referring.
  const [ou] = shapeReferralLoop([
    { school: 'Ohio University', quiz_complete: 14, referred: 4, referred_quiz_complete: 3, referrers: 1 },
  ]);
  assert.equal(ou.k, 0.27);                       // 3 / 11
  assert.equal(ou.referredSignups, 4);
  assert.equal(ou.referredQuizComplete, 3);       // the fourth never finished the quiz
  // Counting the referred among the referrers would give 3/14 = 0.21 and
  // flatters k further with every referral that lands, which is the wrong
  // direction for a number whose job is to say "stop, this is not working".
  assert.notEqual(ou.k, 0.21);
});

test('k is withheld, not rounded, on a campus too small to mean anything', () => {
  const [tiny] = shapeReferralLoop([
    { school: 'UCLA', quiz_complete: 2, referred: 1, referred_quiz_complete: 1, referrers: 1 },
  ]);
  // 1/1 would print as k = 1.0, "self-sustaining", off two students.
  assert.equal(tiny.k, null);
  assert.equal(tiny.kSuppressedBelow, K_MIN_COHORT);
  // The raw counts are still there: suppressed is not hidden.
  assert.equal(tiny.referredQuizComplete, 1);
});

test('a campus with no referrals reports zero, and one just over the line reports a number', () => {
  const rows = shapeReferralLoop([
    { school: 'A', quiz_complete: 40, referred: 0, referred_quiz_complete: 0, referrers: 0 },
    { school: 'B', quiz_complete: 11, referred: 1, referred_quiz_complete: 1, referrers: 1 },
  ]);
  assert.equal(rows[0].k, 0);
  assert.equal(rows[1].k, 0.1);                   // 1 / 10, exactly at the threshold
});

test('a referral loop that has never run does not take the dashboard down with it', async () => {
  // referrals is created lazily on first use, so before anyone generates a
  // code the table is genuinely absent. An earlier version guarded this with a
  // to_regclass CTE inside the same statement, which cannot work: Postgres
  // resolves relations at parse time, so `FROM referrals` raises 42P01 whatever
  // the WHERE clause says. Confirmed against 16.13 with the table dropped.
  const asked = [];
  const pool = {
    query: async (sql) => {
      asked.push(sql);
      if (sql.includes('to_regclass')) return { rows: [{ ok: false }] };
      if (sql === REFERRAL_LOOP_SQL) throw Object.assign(new Error('relation "referrals" does not exist'), { code: '42P01' });
      return { rows: [{ school: 'Ohio University', quiz_complete: 15, referred: 0, referred_quiz_complete: 0, referrers: 0 }] };
    },
  };
  const rows = await fetchReferralLoop(pool);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quiz_complete, 15);
  // It must have asked the probe FIRST and then chosen the campus-only query.
  assert.ok(asked[0].includes('to_regclass'));
  assert.equal(asked[1], CAMPUS_ONLY_SQL);
  assert.ok(!asked.includes(REFERRAL_LOOP_SQL), 'never runs the query that would throw');
});

test('once the table exists it runs the real query', async () => {
  const asked = [];
  const pool = {
    query: async (sql) => {
      asked.push(sql);
      if (sql.includes('to_regclass')) return { rows: [{ ok: true }] };
      return { rows: [] };
    },
  };
  await fetchReferralLoop(pool);
  assert.equal(asked[1], REFERRAL_LOOP_SQL);
});
