// Per-habit agreement for the app's ring pictures. Must match the app's own
// utils/livingProfile.ts + utils/pairFingerprint.ts exactly, and must never
// carry either student's position. node --test.
const test = require('node:test');
const assert = require('node:assert');
const { pairAgreement, livingMeters } = require('./pairAgreement');

const opt = (index) => ({ type: 'option', index });

test('agreement is 100 minus the gap, on the app value tables', () => {
  // Tidiness: index 0 = 92, index 2 = 45 -> 100 - 47 = 53
  const out = pairAgreement({ 50: opt(0) }, { 50: opt(2) });
  assert.deepEqual(out, [{ label: 'Tidiness', agreement: 53 }]);
});

test('identical answers agree fully; opposite ends barely', () => {
  assert.equal(pairAgreement({ 49: opt(1) }, { 49: opt(1) })[0].agreement, 100);
  assert.equal(pairAgreement({ 49: opt(0) }, { 49: opt(3) })[0].agreement, 20);   // 15 vs 95
});

test('a scale answer is read as value - 1, the way the app reads it', () => {
  const out = pairAgreement({ 53: { type: 'scale', value: 1 } }, { 53: opt(0) });
  assert.deepEqual(out, [{ label: 'Quiet at home', agreement: 100 }]);
});

test('only habits BOTH answered, never an invented value', () => {
  const out = pairAgreement({ 50: opt(0), 53: opt(0) }, { 50: opt(0) });
  assert.deepEqual(out.map(x => x.label), ['Tidiness']);
});

test('each side is capped at its first four answered habits, like the app', () => {
  const all = { 50: opt(0), 53: opt(0), 48: opt(0), 49: opt(0), 57: opt(0) };
  assert.equal(livingMeters(all).length, 4);
  assert.equal(pairAgreement(all, all).find(x => x.label === 'Follow-through'), undefined);
});

test('nothing but label and agreement leaves: no position, no answers', () => {
  const out = pairAgreement({ 50: opt(1), 53: opt(2) }, { 50: opt(3), 53: opt(0) });
  for (const row of out) assert.deepEqual(Object.keys(row).sort(), ['agreement', 'label']);
});

test('missing or junk answers produce nothing, not zeros', () => {
  assert.deepEqual(pairAgreement(null, { 50: opt(0) }), []);
  assert.deepEqual(pairAgreement({ 50: opt(9) }, { 50: opt(0) }), []);
  assert.deepEqual(pairAgreement({ 50: 'x' }, { 50: opt(0) }), []);
});
