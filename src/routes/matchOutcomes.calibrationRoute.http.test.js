// GET /match-outcomes/calibration — the route around computeCalibration.
// (The pure bucketing math is covered in matchOutcomes.calibration.test.js.)
//
// Two things pinned here. First, the 404 is a deliberate "still gathering"
// state, not a missing route: the app's does-this-work screen renders its
// honest empty state off it, so turning it into a 200-with-empty-bands would
// silently change what students are shown. Second, the report reads the
// PROMOTED predicted_score column, not just the details JSONB.
// pool/auth stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let rows = [];
let lastSelect = '';
let throwOnSelect = false;

inject('../db/pool', {
  query: async (sql) => {
    if (/FROM match_outcomes/.test(sql) && /SELECT/.test(sql)) {
      if (throwOnSelect) throw new Error('aggregation exploded');
      lastSelect = sql;
      return { rows };
    }
    return { rows: [], rowCount: 0 };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'user-1', email: 'a@ohio.edu' }; next(); },
  refuseBanned: (_q, _s, n) => n(),
});
inject('../utils/sentry', { captureError: () => {} });

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/', require('./matchOutcomes'));

const get = () => request(app).get('/match-outcomes/calibration');

// A resolved, successful day-30 retention answer in a known band.
const answered = (score) => ({
  predicted_score: String(score), stage: 'day30', answer: null, rating: '5',
});

test.beforeEach(() => { rows = []; throwOnSelect = false; lastSelect = ''; });

test('no data ⇒ 404 {ok:false} — the honest "still gathering" state', async () => {
  const res = await get();
  assert.equal(res.status, 404, 'the app renders its empty state off this');
  assert.deepEqual(res.body, { ok: false });
});

test('a failed aggregation degrades to the same honest state, never a curve', async () => {
  throwOnSelect = true;
  const res = await get();
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { ok: false });
});

test('real answered outcomes ⇒ 200 with the measured bands', async () => {
  rows = [answered(90), answered(88), { predicted_score: '60', stage: 'day30', answer: null, rating: '2' }];
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.totalSample, 3);
  const top = res.body.bands.find(b => b.band === '85–100');
  assert.equal(top.sampleSize, 2);
  assert.equal(top.actualSuccess, 1, 'both rated 5 ⇒ 100%');
  const low = res.body.bands.find(b => b.band === '55–69');
  assert.equal(low.actualSuccess, 0, 'rated 2 ⇒ not a success; never rounded up');
});

test('the query reads the PROMOTED column, not only the JSONB', async () => {
  rows = [answered(90)];
  await get();
  assert.match(lastSelect, /COALESCE\(predicted_score::text, details->>'predictedScore'\)/,
    'the promoted column exists so this report does not depend on a JSON path');
  // And the filter must use the same expression, or promoted-only rows are
  // selected but then excluded — or worse, the reverse.
  const uses = lastSelect.match(/COALESCE\(predicted_score::text, details->>'predictedScore'\)/g) || [];
  assert.ok(uses.length >= 2, 'SELECT and WHERE must agree on the source');
});

test('unanswered rows never inflate the denominator', async () => {
  // A pending check-in is not evidence for OR against the prediction.
  rows = [answered(90), { predicted_score: '90', stage: 'day30', answer: 'notyet', rating: null }];
  const res = await get();
  assert.equal(res.body.totalSample, 1);
});
