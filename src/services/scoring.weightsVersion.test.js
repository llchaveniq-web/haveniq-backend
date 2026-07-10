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
  // v10 = v8 lifestyle-first prior + v9 decorrelation (57:18, 63:16) + the v10
  // optional high-friction axes (65:20, 66:28, 67:28, 68:20). If you change
  // QUESTION_POINTS: bump WEIGHTS_VERSION in scoring.js, then update this
  // expected fingerprint. (The app no longer mirrors numeric weights — see the
  // note in constants/quiz.ts — so weight VALUES are backend-only; only the
  // scored QUESTION SET stays in app lockstep.)
  const EXPECTED_V10 =
    '14:35,48:30,49:35,50:45,51:15,52:20,53:25,54:20,55:20,56:30,57:18,60:30,62:28,63:16,65:20,66:28,67:28,68:20';
  assert.equal(WEIGHTS_VERSION, 'v10');
  assert.equal(weightFingerprint(QUESTION_POINTS), EXPECTED_V10);
});
