// Spec §5 — the stress check-in item ("How did the last stressful stretch go?").
// The whole point of this field is the prediction↔outcome PAIR: an outcome we
// can't attach to what the clash matrix predicted proves nothing. These tests
// pin the enum, the server-side pattern lookup, and the fail-open behavior.
// pool/auth/sentry stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// Records every INSERT so we can assert on the columns actually written, and
// serves whatever under_pressure row the test sets up.
const inserts = [];
let patternRow = [];          // rows returned for the compatibility_scores lookup
let lookupSql = null;
inject('../db/pool', {
  query: async (sql, params) => {
    if (/INSERT INTO match_outcomes/.test(sql)) { inserts.push(params); return { rows: [] }; }
    if (/FROM compatibility_scores/.test(sql)) { lookupSql = sql; return { rows: patternRow }; }
    return { rows: [] };
  },
});
inject('../middleware/auth', { requireAuth: (req, _res, next) => { req.user = { id: 'user-a' }; next(); } });
inject('../utils/sentry', { captureError: () => {} });
delete process.env.DISCORD_WEBHOOK_URL;

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/', require('./matchOutcomes'));

const post = (details) =>
  request(app).post('/me/match-outcomes')
    .send({ otherUserId: 'user-b', outcome: 'survey_60d', details });

// INSERT param order: reporter, other, outcome, details, predScore, predTier, stressStretch, predPattern
const STRETCH = 6, PATTERN = 7;

test.beforeEach(() => { inserts.length = 0; patternRow = []; lookupSql = null; });

for (const v of ['smooth', 'bumpy', 'clashed']) {
  test(`accepts the "${v}" stretch answer`, async () => {
    patternRow = [{ pattern: 'pursue_withdraw' }];
    const res = await post({ stage: 'day60', stressStretch: v });
    assert.equal(res.status, 200);
    assert.equal(inserts[0][STRETCH], v);
  });
}

test('stores the outcome against the pattern we PREDICTED for the pair', async () => {
  patternRow = [{ pattern: 'both_suppress' }];
  await post({ stage: 'day60', stressStretch: 'clashed' });
  assert.equal(inserts[0][STRETCH], 'clashed');
  assert.equal(inserts[0][PATTERN], 'both_suppress', 'the pair is what makes this data usable');
});

test('the predicted pattern is read server-side, never taken from the payload', async () => {
  patternRow = [{ pattern: 'complementary' }];
  // A client claiming we predicted a clash must not be able to relabel the row.
  await post({ stage: 'day60', stressStretch: 'clashed', predictedPattern: 'pursue_withdraw' });
  assert.equal(inserts[0][PATTERN], 'complementary');
});

test('the pair lookup matches either stored direction', async () => {
  patternRow = [{ pattern: 'recovery_mismatch' }];
  await post({ stage: 'day60', stressStretch: 'bumpy' });
  assert.match(lookupSql, /user_a = \$1 AND user_b = \$2/);
  assert.match(lookupSql, /user_a = \$2 AND user_b = \$1/);
});

test('an off-vocab answer is dropped, not stored', async () => {
  const res = await post({ stage: 'day60', stressStretch: 'it was fine i guess' });
  assert.equal(res.status, 200, 'a bad stress answer must not fail the whole check-in');
  assert.equal(inserts[0][STRETCH], null);
  assert.equal(inserts[0][PATTERN], null);
});

test('an absent stress answer records nothing and skips the lookup (today\'s check-ins)', async () => {
  const res = await post({ stage: 'day60', rating: 4 });
  assert.equal(res.status, 200);
  assert.equal(inserts[0][STRETCH], null);
  assert.equal(inserts[0][PATTERN], null);
  assert.equal(lookupSql, null, 'no stress answer ⇒ no wasted query');
});

test('a pair with no stored prediction still records the outcome', async () => {
  patternRow = [];   // scored before the stress dimension shipped
  const res = await post({ stage: 'day60', stressStretch: 'smooth' });
  assert.equal(res.status, 200);
  assert.equal(inserts[0][STRETCH], 'smooth');
  assert.equal(inserts[0][PATTERN], null);
});

test('the stress answer is preserved in details too (back-compat reader)', async () => {
  patternRow = [{ pattern: 'both_suppress' }];
  await post({ stage: 'day60', stressStretch: 'bumpy', note: 'we sorted it out' });
  assert.equal(inserts[0][3].stressStretch, 'bumpy');
});
