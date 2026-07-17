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
  // Fingerprint of the raw QUESTION_POINTS. v11.0 did NOT change these points —
  // its reweight is a cross-category aggregation model (CATEGORY_WEIGHTS_V11),
  // applied only when MATCHING_V11 is on — so the point fingerprint is unchanged
  // from v10; only the version stamp moved. If you ever change QUESTION_POINTS:
  // bump WEIGHTS_VERSION and update this expected fingerprint. (The app no longer
  // mirrors numeric weights — see constants/quiz.ts — so weight VALUES are
  // backend-only; only the scored QUESTION SET stays in app lockstep.)
  //
  // v11.1 — ids 65, 66, 67 REMOVED from this fingerprint. They were the v10
  // thermostat / sleep-sensitivity / bill-reliability axes, which the app never
  // shipped: no user ever answered them, and a qid only reaches rawScore/maxScore
  // when BOTH users answered, so they could never move a score (verified against
  // production: 0 quiz_answers rows contain keys 65/66/67). They are now the
  // STRESS questions the app stages at those ids, scored categorically by the
  // clash matrix — deliberately NOT here, because this set is the ORDINAL scorer.
  const EXPECTED_POINTS =
    '14:35,48:30,49:35,50:45,51:15,52:20,53:25,54:20,55:20,56:30,57:18,60:30,62:28,63:16,68:20';
  assert.equal(WEIGHTS_VERSION, 'v11.1');
  assert.equal(weightFingerprint(QUESTION_POINTS), EXPECTED_POINTS);
});
