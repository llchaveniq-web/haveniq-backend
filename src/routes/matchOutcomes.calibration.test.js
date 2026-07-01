// Tests for the cohort calibration report — GET /match-outcomes/calibration.
// The pure bucketing/success logic is tested directly (no DB); the HTTP
// contract (shape, empty → ok:false, failed aggregation → ok:false) is tested
// with a stubbed pool + auth via the require cache. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── Stub DB + auth BEFORE requiring the route ──
let fakeRows = [];
let dbShouldThrow = false;
const fakePool = {
  query: async () => {
    if (dbShouldThrow) throw new Error('boom');
    // The route only queries match_outcomes for calibration; ensureTable's
    // CREATE TABLE also lands here and is fine to no-op.
    return { rows: fakeRows };
  },
};
inject('../db/pool', fakePool);
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'user-123' }; next(); },
});

const express = require('express');
const request = require('supertest');
const matchOutcomes = require('./matchOutcomes');
const { computeCalibration, isAnswered, isSuccess, bandFor } = matchOutcomes._calibration;

const app = express();
app.use(express.json());
app.use('/', matchOutcomes);

test.beforeEach(() => { fakeRows = []; dbShouldThrow = false; });

// ── isAnswered: only RESOLVED responses count ──────────────────────────────
test('isAnswered: meet48 yes/no are answered; notyet / missing are not', () => {
  assert.equal(isAnswered({ stage: 'meet48', answer: 'yes' }), true);
  assert.equal(isAnswered({ stage: 'meet48', answer: 'no' }), true);
  assert.equal(isAnswered({ stage: 'meet48', answer: 'notyet' }), false);
  assert.equal(isAnswered({ stage: 'meet48' }), false);
});

test('isAnswered: retention needs a rating OR a decisive yes/no', () => {
  assert.equal(isAnswered({ stage: 'day30', rating: 3 }), true);
  assert.equal(isAnswered({ stage: 'day60', answer: 'no' }), true);
  assert.equal(isAnswered({ stage: 'day90', answer: 'notyet' }), false);
  assert.equal(isAnswered({ stage: 'month6' }), false);
});

test('isAnswered: an unknown / missing stage is never answered', () => {
  assert.equal(isAnswered({ stage: 'weird', answer: 'yes' }), false);
  assert.equal(isAnswered({ answer: 'yes', rating: 5 }), false);
});

// ── isSuccess: met48 met, retention rating>=4 ──────────────────────────────
test('isSuccess: meet48 succeeds only on answer=yes', () => {
  assert.equal(isSuccess({ stage: 'meet48', answer: 'yes' }), true);
  assert.equal(isSuccess({ stage: 'meet48', answer: 'no' }), false);
  assert.equal(isSuccess({ stage: 'meet48', answer: 'notyet' }), false);
});

test('isSuccess: retention succeeds only on rating >= 4 (rating, not answer)', () => {
  assert.equal(isSuccess({ stage: 'day30', rating: 4 }), true);
  assert.equal(isSuccess({ stage: 'day90', rating: 5 }), true);
  assert.equal(isSuccess({ stage: 'day60', rating: 3 }), false);
  // A retention 'yes' with no rating is NOT a success under the strict defn.
  assert.equal(isSuccess({ stage: 'month6', answer: 'yes' }), false);
});

// ── bandFor: correct boundaries ────────────────────────────────────────────
test('bandFor: boundaries land in the right band', () => {
  assert.equal(bandFor(100).band, '85–100');
  assert.equal(bandFor(85).band, '85–100');
  assert.equal(bandFor(84).band, '70–84');
  assert.equal(bandFor(70).band, '70–84');
  assert.equal(bandFor(69).band, '55–69');
  assert.equal(bandFor(55).band, '55–69');
  assert.equal(bandFor(54).band, 'Below 55');
  assert.equal(bandFor(0).band, 'Below 55');
});

// ── computeCalibration: empty / no-answered → ok:false ─────────────────────
test('computeCalibration: no rows → ok:false (never fabricated bands)', () => {
  assert.deepEqual(computeCalibration([]), { ok: false });
  assert.deepEqual(computeCalibration(null), { ok: false });
});

test('computeCalibration: rows with no predicted score → ok:false', () => {
  const r = computeCalibration([{ stage: 'meet48', answer: 'yes' }]);
  assert.deepEqual(r, { ok: false });
});

test('computeCalibration: only pending/notyet answers → ok:false', () => {
  const r = computeCalibration([
    { predictedScore: 90, stage: 'meet48', answer: 'notyet' },
    { predictedScore: 60, stage: 'day30' },
  ]);
  assert.deepEqual(r, { ok: false });
});

// ── computeCalibration: real aggregation ───────────────────────────────────
test('computeCalibration: buckets, success rate, and shape are correct', () => {
  const rows = [
    // 85–100: 3 answered, 2 success → 0.667
    { predictedScore: 95, stage: 'meet48', answer: 'yes' },
    { predictedScore: 88, stage: 'day30', rating: 5 },
    { predictedScore: 90, stage: 'meet48', answer: 'no' },
    // 70–84: 2 answered, 1 success → 0.5
    { predictedScore: 80, stage: 'meet48', answer: 'yes' },
    { predictedScore: 72, stage: 'day60', rating: 2 },
    // 55–69: 1 answered, 0 success → 0
    { predictedScore: 60, stage: 'meet48', answer: 'no' },
    // Below 55: 1 answered, 1 success → 1
    { predictedScore: 40, stage: 'month6', rating: 4 },
    // excluded: pending, and no predicted score
    { predictedScore: 99, stage: 'meet48', answer: 'notyet' },
    { stage: 'meet48', answer: 'yes' },
  ];
  const r = computeCalibration(rows);
  assert.equal(r.ok, true);
  assert.equal(r.totalSample, 7);
  // Bands are emitted high→low, only non-empty ones.
  assert.deepEqual(r.bands, [
    { band: '85–100',   min: 85, actualSuccess: 0.667, sampleSize: 3 },
    { band: '70–84',    min: 70, actualSuccess: 0.5,   sampleSize: 2 },
    { band: '55–69',    min: 55, actualSuccess: 0,     sampleSize: 1 },
    { band: 'Below 55', min: 0,  actualSuccess: 1,     sampleSize: 1 },
  ]);
});

test('computeCalibration: empty bands are omitted, not zero-padded', () => {
  const r = computeCalibration([{ predictedScore: 95, stage: 'meet48', answer: 'yes' }]);
  assert.equal(r.ok, true);
  assert.equal(r.totalSample, 1);
  assert.equal(r.bands.length, 1);
  assert.equal(r.bands[0].band, '85–100');
});

test('computeCalibration: rating arrives as a string (from JSONB ->>)', () => {
  const r = computeCalibration([
    { predictedScore: '88', stage: 'day30', rating: '4' },
    { predictedScore: '86', stage: 'day30', rating: '3' },
  ]);
  assert.equal(r.totalSample, 2);
  assert.deepEqual(r.bands, [
    { band: '85–100', min: 85, actualSuccess: 0.5, sampleSize: 2 },
  ]);
});

// ── HTTP contract ──────────────────────────────────────────────────────────
test('GET /match-outcomes/calibration: no data → 404 { ok:false }', async () => {
  fakeRows = [];
  const res = await request(app).get('/match-outcomes/calibration');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { ok: false });
});

test('GET /match-outcomes/calibration: populated → correct payload shape', async () => {
  fakeRows = [
    { predicted_score: '95', stage: 'meet48', answer: 'yes', rating: null },
    { predicted_score: '90', stage: 'meet48', answer: 'no', rating: null },
    { predicted_score: '72', stage: 'day60', answer: 'yes', rating: '5' },
  ];
  const res = await request(app).get('/match-outcomes/calibration');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.totalSample, 3);
  assert.deepEqual(res.body.bands, [
    { band: '85–100', min: 85, actualSuccess: 0.5, sampleSize: 2 },
    { band: '70–84',  min: 70, actualSuccess: 1,   sampleSize: 1 },
  ]);
  // Never leaks an individual: no user ids / answers in the response.
  const blob = JSON.stringify(res.body);
  assert.ok(!blob.includes('user'));
  assert.ok(!blob.includes('answer'));
});

test('GET /match-outcomes/calibration: failed aggregation → 404 { ok:false }', async () => {
  dbShouldThrow = true;
  const res = await request(app).get('/match-outcomes/calibration');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { ok: false });
});
