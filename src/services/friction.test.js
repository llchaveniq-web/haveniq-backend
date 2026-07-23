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

// ─── Mirrored client detectors (docs/specs/forecast-detector-gaps.md) ──────
// These exist because the forecast of record for a REAL matched pair is this
// backend module — the client's predictFriction runs on {} because the feed
// never ships another student's raw answers. A client-only fix reaches nobody.
// Option indices verified against src/data/quizQuestions.js before writing.

const only = (A, B, id) => computeFrictions(A, B, { n: 10 }).find(f => f.id === id) || null;

// ── Q14 contempt: 0 = eye-rolls/mocks, 1 = keeps it civil ──
test('contempt fires when EITHER side is contempt-prone, higher when both', () => {
  assert.equal(only({ 14: 0 }, { 14: 1 }, 'friction_contempt').severity, 0.8);
  assert.equal(only({ 14: 1 }, { 14: 0 }, 'friction_contempt').severity, 0.8);
  assert.equal(only({ 14: 0 }, { 14: 0 }, 'friction_contempt').severity, 0.9);
  assert.equal(only({ 14: 1 }, { 14: 1 }, 'friction_contempt'), null, 'both civil ⇒ silent');
});

test('contempt copy names the right side', () => {
  assert.match(only({ 14: 0 }, { 14: 1 }, 'friction_contempt').mechanism, /^You said/);
  assert.match(only({ 14: 1 }, { 14: 0 }, 'friction_contempt').mechanism, /^They said/);
  assert.match(only({ 14: 0 }, { 14: 0 }, 'friction_contempt').title, /both/i);
});

// ── Q52 overnight partners: 0 = totally fine … 3 = keep to a minimum ──
test('overnight fires at a 2-notch gap and scales to 3', () => {
  assert.equal(only({ 52: 0 }, { 52: 1 }, 'friction_overnight'), null, 'a 1-notch gap is not friction');
  assert.equal(only({ 52: 0 }, { 52: 2 }, 'friction_overnight').severity, 0.72);
  assert.equal(only({ 52: 0 }, { 52: 3 }, 'friction_overnight').severity, 0.86);
});

test('overnight: the LESS tolerant side (higher Q52) is the one it lands on', () => {
  // Viewer is the less-tolerant one ⇒ "your space quietly shrinks".
  assert.match(only({ 52: 3 }, { 52: 0 }, 'friction_overnight').mechanism, /you're the one whose space/);
  assert.match(only({ 52: 0 }, { 52: 3 }, 'friction_overnight').mechanism, /they're the one whose space/);
});

// ── Q54 drinking at home ── (distinct from Q51 smoke/vape/cannabis)
test('drinking fires on a 2-notch gap, band 0.64 → 0.78', () => {
  assert.equal(only({ 54: 0 }, { 54: 1 }, 'friction_drinking'), null);
  assert.equal(only({ 54: 0 }, { 54: 2 }, 'friction_drinking').severity, 0.64);
  assert.equal(only({ 54: 0 }, { 54: 3 }, 'friction_drinking').severity, 0.78);
});

test('drinking is separate from the smoke/vape detector', () => {
  const f = computeFrictions({ 51: 0, 54: 0 }, { 51: 3, 54: 3 }, { n: 10 }).map(x => x.id);
  assert.ok(f.includes('friction_drinking'));
  // Q51 at a 3-gap is a hard-block extreme the substance detector deliberately
  // skips; the point here is only that the two axes are independent.
  assert.ok(!f.includes('friction_substance') || f.length >= 2);
});

// ── Q56 money: 0-1 vigilant, 2 avoidance, 3 status ──
test('money now fires vigilant↔STATUS (the max gap), which used to be silent', () => {
  const f = only({ 56: 0 }, { 56: 3 }, 'friction_money');
  assert.ok(f, 'vigilant vs status must fire — it fired nothing before');
  assert.equal(f.severity, 0.8);
  assert.match(f.title, /treat money differently/);
  assert.match(f.mechanism, /aspirationally/, 'values clash, not the attention gap');
});

test('money keeps the original attention-gap copy vs avoidance', () => {
  const f = only({ 56: 1 }, { 56: 2 }, 'friction_money');
  assert.equal(f.severity, 0.78);
  assert.match(f.mechanism, /tunes out money signals/);
});

test('money stays silent when both share the vigilance, or neither is vigilant', () => {
  assert.equal(only({ 56: 0 }, { 56: 1 }, 'friction_money'), null);
  assert.equal(only({ 56: 2 }, { 56: 3 }, 'friction_money'), null, 'no vigilant side ⇒ no tracker to resent');
});

// ── Q62 + Q60 mutual avoidance: fires on SAMENESS, not a gap ──
test('mutual avoidance fires only when NEITHER side can say no', () => {
  assert.ok(only({ 62: 0 }, { 62: 1 }, 'friction_mutual_avoidance'));
  assert.ok(only({ 62: 0 }, { 62: 0 }, 'friction_mutual_avoidance'));
  // A designated raiser on either side defuses it.
  assert.equal(only({ 62: 0 }, { 62: 2 }, 'friction_mutual_avoidance'), null);
  assert.equal(only({ 62: 3 }, { 62: 0 }, 'friction_mutual_avoidance'), null);
});

test('mutual avoidance amplifies ONLY when both bottle it (Q60 === 3)', () => {
  assert.equal(only({ 62: 0, 60: 3 }, { 62: 1, 60: 3 }, 'friction_mutual_avoidance').severity, 0.82);
  // Q60 index 2 = "need to talk it through" = a RAISER. Must not amplify.
  assert.equal(only({ 62: 0, 60: 2 }, { 62: 1, 60: 2 }, 'friction_mutual_avoidance').severity, 0.7);
  assert.equal(only({ 62: 0, 60: 3 }, { 62: 1, 60: 0 }, 'friction_mutual_avoidance').severity, 0.7,
    'one bottler is not both');
});

// ── Q50 cleanliness amplifier (the overclaim fix) ──
test('cleanliness amplifier keys on Q60 === 3, never on index 2', () => {
  const base = only({ 50: 0, 60: 0, 62: 3 }, { 50: 2 }, 'friction_cleanliness');
  const talk = only({ 50: 0, 60: 2, 62: 3 }, { 50: 2 }, 'friction_cleanliness');
  const bott = only({ 50: 0, 60: 3, 62: 3 }, { 50: 2 }, 'friction_cleanliness');
  assert.equal(base.severity, 0.75);
  assert.equal(talk.severity, 0.75, 'index 2 WANTS to raise it — must not read as held-in resentment');
  assert.equal(bott.severity, 0.81);
  assert.ok(!/hold it in/.test(talk.mechanism));
  assert.ok(/hold it in/.test(bott.mechanism));
});

test('cleanliness also amplifies when the tidier side is a people-pleaser (Q62 <= 1)', () => {
  assert.equal(only({ 50: 0, 60: 0, 62: 1 }, { 50: 2 }, 'friction_cleanliness').severity, 0.81);
});

test('cleanliness names whichever side is actually tidier', () => {
  assert.match(only({ 50: 0 }, { 50: 3 }, 'friction_cleanliness').mechanism, /^You keep/);
  assert.match(only({ 50: 3 }, { 50: 0 }, 'friction_cleanliness').mechanism, /^They keep/);
});

// ── Global invariants ──
test('no detector can exceed the 0.98 severity cap', () => {
  const QS = [14, 48, 49, 50, 51, 52, 54, 56, 57, 60, 62];
  let max = 0;
  for (let i = 0; i < 3000; i++) {
    const A = {}, B = {};
    for (const q of QS) {
      const n = q === 14 ? 2 : 4;
      A[q] = i % n; B[q] = (i * 7 + q) % n;
    }
    for (const f of computeFrictions(A, B, { n: 10 })) max = Math.max(max, f.severity);
  }
  assert.ok(max < 0.98, `max severity ${max} must stay under the cap`);
});

test('every emitted forecast carries the full documented shape', () => {
  const all = computeFrictions(
    { 14: 0, 50: 0, 52: 3, 54: 3, 56: 0, 60: 3, 62: 0 },
    { 14: 0, 50: 3, 52: 0, 54: 0, 56: 3, 60: 3, 62: 1 },
    { n: 10 },
  );
  assert.ok(all.length >= 5, 'this pair should trip most detectors');
  for (const f of all) {
    for (const k of ['id', 'category', 'title', 'mechanism', 'mitigation', 'severity', 'emoji', 'dim']) {
      assert.ok(f[k] !== undefined && f[k] !== null && f[k] !== '', `${f.id} missing ${k}`);
    }
    assert.equal(typeof f.severity, 'number');
    assert.equal(typeof f.dim, 'number');
  }
});
