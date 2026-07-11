'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { buildFrozenVector } = require('./formationCapture');

test('assembles the scored pair vector from both answer sets', () => {
  const v = buildFrozenVector({
    aAnswers: { 50: 0, 49: 1, 14: 1 },
    bAnswers: { 50: 3, 49: 1, 14: 0 },
    scoreAtMatch: 82.4,
  });
  assert.strictEqual(v.v, 1);
  assert.strictEqual(v.scoreAtMatch, 82, 'score rounded');
  assert.ok(v.pair && v.pair.q, 'pair.q present');
  assert.ok(v.pair.q['50'] && v.pair.q['49'] && v.pair.q['14'], 'shared questions captured');
});

test('only questions BOTH answered enter the pair vector', () => {
  const v = buildFrozenVector({ aAnswers: { 50: 0, 49: 1 }, bAnswers: { 50: 1 } });
  assert.ok(v.pair.q['50'], 'shared 50 present');
  assert.ok(!v.pair.q['49'], '49 (only A answered) excluded — preserves the both-answered invariant');
});

test('zero-weight channels captured per user [a, b]', () => {
  const v = buildFrozenVector({
    aAnswers: { 50: 0 }, bAnswers: { 50: 1 },
    aVoice: [{ q: 1 }, { q: 2 }], bVoice: null,   // A has voice answers, B does not
    aVouches: 3, bVouches: 0,
  });
  assert.deepStrictEqual(v.channels.voice, [1, 0], 'voice presence');
  assert.deepStrictEqual(v.channels.vouches, [3, 0], 'approved vouch counts');
  assert.deepStrictEqual(v.channels.latency, [null, null], 'latency null until a loader lands (zero-weight)');
});

test('scoreAtMatch is null when not provided', () => {
  const v = buildFrozenVector({ aAnswers: { 50: 0 }, bAnswers: { 50: 0 } });
  assert.strictEqual(v.scoreAtMatch, null);
});

test('empty voice arrays read as absent (0)', () => {
  const v = buildFrozenVector({ aAnswers: { 50: 0 }, bAnswers: { 50: 1 }, aVoice: [], bVoice: [{}] });
  assert.deepStrictEqual(v.channels.voice, [0, 1]);
});
