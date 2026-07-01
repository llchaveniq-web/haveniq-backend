// Tests for Phase 4 metrics: Brier, AUC, monotonicity, and the honesty-gated
// public headline. Pure — no DB. node --test.
const test = require('node:test');
const assert = require('node:assert');
const m = require('./calibrationMetrics');

test('brierScore: perfect forecast = 0, coin flip = 0.25, empty = null', () => {
  assert.equal(m.brierScore([{ p: 1, y: 1 }, { p: 0, y: 0 }]), 0);
  assert.equal(m.brierScore([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }]), 0.25);
  assert.equal(m.brierScore([]), null);
});

test('auc: perfect ranking = 1, inverted = 0, ties = 0.5, one class = null', () => {
  assert.equal(m.auc([{ p: 0.9, y: 1 }, { p: 0.1, y: 0 }]), 1);
  assert.equal(m.auc([{ p: 0.1, y: 1 }, { p: 0.9, y: 0 }]), 0);
  assert.equal(m.auc([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }]), 0.5);
  assert.equal(m.auc([{ p: 0.9, y: 1 }]), null);              // only positives
});

test('isMonotonic: non-increasing high→low is monotonic', () => {
  assert.equal(m.isMonotonic([{ actualSuccess: 0.8 }, { actualSuccess: 0.6 }, { actualSuccess: 0.4 }]), true);
  assert.equal(m.isMonotonic([{ actualSuccess: 0.6 }, { actualSuccess: 0.8 }]), false);
  assert.equal(m.isMonotonic([{ actualSuccess: 0.8 }]), false); // need >= 2 bands
});

// ── publicHeadline: honest gating ───────────────────────────────────────────
const GOOD = {
  totalSample: 142,
  bands: [
    { band: '85–100', min: 85, actualSuccess: 0.8, sampleSize: 46 },
    { band: '70–84',  min: 70, actualSuccess: 0.6, sampleSize: 58 },
    { band: '55–69',  min: 55, actualSuccess: 0.4, sampleSize: 38 },
  ],
};

test('publicHeadline: real cohort with lift → an honest Nx claim', () => {
  const h = m.publicHeadline(GOOD);
  assert.equal(h.ok, true);
  assert.equal(h.multiple, 2);                    // 0.8 / 0.4
  assert.ok(h.headline.includes('85–100'));
  assert.ok(h.headline.includes('2×'));
});

test('publicHeadline: below the PUBLIC sample bar → ok:false (never fabricated)', () => {
  assert.deepEqual(m.publicHeadline({ ...GOOD, totalSample: 40 }), { ok: false });
});

test('publicHeadline: no real spread / no lift → ok:false', () => {
  const flat = { totalSample: 100, bands: [
    { band: '85–100', min: 85, actualSuccess: 0.5, sampleSize: 50 },
    { band: '55–69',  min: 55, actualSuccess: 0.5, sampleSize: 50 },
  ] };
  assert.deepEqual(m.publicHeadline(flat), { ok: false });   // multiple == 1
  // Reference band at 0 success → no honest denominator.
  const zeroRef = { totalSample: 100, bands: [
    { band: '85–100', min: 85, actualSuccess: 0.7, sampleSize: 50 },
    { band: '55–69',  min: 55, actualSuccess: 0,   sampleSize: 50 },
  ] };
  assert.deepEqual(m.publicHeadline(zeroRef), { ok: false });
});

test('publicHeadline: fewer than 2 real bands → ok:false', () => {
  assert.deepEqual(m.publicHeadline({ totalSample: 100, bands: [
    { band: '85–100', min: 85, actualSuccess: 0.8, sampleSize: 100 },
  ] }), { ok: false });
});
