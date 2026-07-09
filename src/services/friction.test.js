'use strict';

// The friction forecast is the differentiating half of the matching wedge —
// "where you'll clash + the exact script". These lock that it fires ONLY on a
// real gap on a question BOTH answered, ranks by severity, caps at N, tolerates
// the stored wire shape, and honors complementarity suppression. node --test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeFrictions } = require('./friction');

// helpers to build answer maps in either wire shape
const opt = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { type: 'option', index: v }]));
const bare = (m) => ({ ...m });

test('a big sleep gap fires the sleep forecast with a script', () => {
  const f = computeFrictions(opt({ 49: 0 }), opt({ 49: 3 }));
  const sleep = f.find((x) => x.dim === 49);
  assert.ok(sleep, 'sleep friction should fire on a 3-notch bedtime gap');
  assert.equal(sleep.category, 'sleep');
  assert.ok(sleep.mechanism.length > 20 && sleep.mitigation.length > 20, 'has mechanism + script');
  assert.equal(sleep.severity, 0.95); // >=3 apart → top severity
});

test('close answers produce no friction', () => {
  assert.deepEqual(computeFrictions(opt({ 49: 1, 50: 1 }), opt({ 49: 2, 50: 1 })), []);
});

test('only questions BOTH answered can fire', () => {
  assert.deepEqual(computeFrictions(opt({ 49: 0 }), opt({ 50: 3 })), []);
});

test('money: vigilance vs avoidance fires; two vigilant do not', () => {
  assert.ok(computeFrictions(opt({ 56: 0 }), opt({ 56: 2 })).some((x) => x.dim === 56));
  assert.deepEqual(computeFrictions(opt({ 56: 0 }), opt({ 56: 1 })), []); // both vigilant → no forecast
});

test('substance mid-range fires; a hard-block extreme does not', () => {
  assert.ok(computeFrictions(opt({ 51: 0 }), opt({ 51: 1 })).some((x) => x.dim === 51)); // never vs cannabis-occ
  assert.deepEqual(computeFrictions(opt({ 51: 0 }), opt({ 51: 3 })), []);                 // never vs regularly = hard block, not a "heads up"
});

test('ranks by severity and caps at N', () => {
  // sleep(0.95) + cleanliness(0.92) + guests(0.85) + chores(0.7) all fire; cap 2
  const f = computeFrictions(
    opt({ 49: 0, 50: 0, 48: 0, 57: 0 }),
    opt({ 49: 3, 50: 3, 48: 3, 57: 3 }),
    { n: 2 },
  );
  assert.equal(f.length, 2);
  assert.ok(f[0].severity >= f[1].severity);
  assert.equal(f[0].dim, 49); // highest severity first
});

test('a certified-complementary dim is suppressed (a balance, not a fight)', () => {
  const both = computeFrictions(opt({ 49: 0 }), opt({ 49: 3 }));
  assert.ok(both.some((x) => x.dim === 49));
  const suppressed = computeFrictions(opt({ 49: 0 }), opt({ 49: 3 }), { suppressDims: [49] });
  assert.deepEqual(suppressed, []);
});

test('tolerates bare-number wire shape too', () => {
  assert.ok(computeFrictions(bare({ 50: 0 }), bare({ 50: 3 })).some((x) => x.dim === 50));
});
