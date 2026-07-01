// Guards the shared weight version stamp. QUESTION_POINTS is mirrored in the
// app (constants/quiz.ts / quizStore.ts); the two MUST move together. This pins
// a fingerprint of the live weights to WEIGHTS_VERSION: change the weights
// without bumping the stamp (here AND in the app) and this fails in CI. node --test.
const test = require('node:test');
const assert = require('node:assert');
const { QUESTION_POINTS, WEIGHTS_VERSION } = require('./scoring');
const { weightFingerprint } = require('./weightLearning');

test('WEIGHTS_VERSION is exported and stamped', () => {
  assert.equal(typeof WEIGHTS_VERSION, 'string');
  assert.ok(WEIGHTS_VERSION.length > 0);
});

test('QUESTION_POINTS fingerprint is pinned to the current version', () => {
  // v8 expert prior (2026-06-24). If you change QUESTION_POINTS: bump
  // WEIGHTS_VERSION in scoring.js AND the app in the same commit, then update
  // this expected fingerprint. That lockstep is the whole point of the stamp.
  const EXPECTED_V8 =
    '14:35,48:30,49:35,50:45,51:15,52:20,53:25,54:20,55:20,56:30,57:18,60:30,62:28,63:16';
  assert.equal(WEIGHTS_VERSION, 'v8');
  assert.equal(weightFingerprint(QUESTION_POINTS), EXPECTED_V8);
});
