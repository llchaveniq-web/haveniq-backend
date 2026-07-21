// Regression: every consumer must read the stored answers map through the
// scorer's flatten.
//
// Production stores EVERY answer as { type:'option', index:N } (verified
// 2026-07-21: 3/3 users, 95/95 answers, zero plain numbers). Three consumers
// had re-implemented the coercion by hand and got it wrong for that shape:
//
//   users.js (About You)      Number({type:'option',index:0}) -> NaN, so the
//                             prompt told Claude the user chose "(option NaN)"
//                             for every question while instructing it to treat
//                             those lines as ground truth.
//   matchedMoment.js          Number(a) === Number(b) compared NaN to NaN,
//                             which is ALWAYS false, so two users with
//                             identical answers shared nothing.
//   groups.js                 handled objects but silently dropped the numeric
//                             string form the scorer accepts.
//
// These tests use the REAL production shape. The pre-existing suites used
// plain-number fixtures, which is exactly why none of them caught it.
// node --test.
const test = require('node:test');
const assert = require('node:assert');
const { flatten } = require('./scoring');

// The shape production actually stores.
const opt = (index) => ({ type: 'option', index });

test('flatten reads the production { type, index } shape', () => {
  assert.deepEqual(flatten({ 1: opt(0), 3: opt(2) }), { 1: 0, 3: 2 });
});

test('index 0 survives — it is a real option, not absence', () => {
  const f = flatten({ 1: opt(0) });
  assert.strictEqual(f[1], 0, 'a truthiness check here would erase the first option');
});

test('flatten still reads plain numbers and numeric strings', () => {
  assert.deepEqual(flatten({ 1: 2, 3: '1', 5: opt(3) }), { 1: 2, 3: 1, 5: 3 });
});

test('flatten reads the { value } variant too', () => {
  assert.deepEqual(flatten({ 7: { value: 2 } }), { 7: 2 });
});

test('unreadable answers are DROPPED, never coerced to 0', () => {
  // The whole bug class: Number(null) === 0 and Number({...}) === NaN. A
  // missing/garbage answer must vanish, not become "chose the first option".
  const f = flatten({ 1: null, 2: undefined, 3: {}, 4: 'abc', 5: '', 6: [] });
  assert.deepEqual(f, {}, 'nothing may be invented from an unreadable value');
});

// ── The two live failures, pinned at the behavior level ──
test('identical production-shaped answers compare as EQUAL (Matched Moment)', () => {
  const A = { 1: opt(0), 3: opt(2), 9: opt(1) };
  const B = { 1: opt(0), 3: opt(2), 9: opt(1) };
  const fa = flatten(A), fb = flatten(B);
  const shared = Object.entries(fa).filter(([q, v]) => fb[q] === v);
  assert.equal(shared.length, 3, 'raw Number() comparison gave 0 here — NaN !== NaN');
});

test('differing answers still do NOT match (the fix must not over-match)', () => {
  const fa = flatten({ 1: opt(0) }), fb = flatten({ 1: opt(3) });
  assert.notEqual(fa[1], fb[1]);
});

test('a production-shaped answer maps to real option TEXT (About You)', () => {
  const QUIZ = require('../data/quizQuestions');
  const byId = Object.fromEntries(QUIZ.map(q => [q.id, q]));
  const qid = QUIZ.find(q => Array.isArray(q.options) && q.options.length > 1).id;
  const idx = flatten({ [qid]: opt(1) })[qid];
  const chosen = byId[qid].options[idx];
  assert.equal(typeof chosen, 'string');
  assert.ok(chosen.length > 0);
  assert.ok(!String(chosen).includes('NaN'), 'the prompt must never say "(option NaN)"');
});
