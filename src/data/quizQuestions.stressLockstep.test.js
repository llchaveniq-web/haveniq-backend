// Lockstep guard: src/data/quizQuestions.js (the AI-prompt text mirror) vs
// src/services/scoring.js's STRESS_IDS/STRESS_STYLES (the live scoring
// engine's understanding of the same three question ids).
//
// These drifted: quizQuestions.js kept the OLD content for ids 65/66/67
// (thermostat preference / noise sensitivity / rent-payment timing) from
// before those ids were reclaimed for the stress-response dimension, while
// scoring.js correctly treated them as stress questions. The frontend
// (constants/quiz.ts) confirms 65/66/67 are genuinely live stress-response
// items — so quizQuestions.js was the stale side. Every AI prompt that
// rendered question text for a pair (About You, Matched Moment, /explain,
// /openers) was telling Claude a user answered a thermostat question when
// they'd actually answered a coping-style question, and the deterministic
// "Under pressure" conflict forecast — which DOES score for real, moving a
// pair's actual displayed compatibility percentage — was being narrated
// with fabricated-sounding claims about temperature/noise/bills that have
// nothing to do with what was actually measured.
//
// This pins the two files to the same shape so they can't silently
// re-diverge. node --test.
const test = require('node:test');
const assert = require('node:assert/strict');
const QUIZ_QUESTIONS = require('./quizQuestions');
const { STRESS_IDS, STRESS_STYLES } = require('../services/scoring');

const byId = Object.fromEntries(QUIZ_QUESTIONS.map((q) => [q.id, q]));

test('every STRESS_ID has a quizQuestions.js entry categorized "stress"', () => {
  for (const id of STRESS_IDS) {
    const q = byId[id];
    assert.ok(q, `quizQuestions.js is missing an entry for stress id ${id}`);
    assert.equal(q.category, 'stress', `id ${id} should be categorized "stress"`);
  }
});

test('option COUNT matches STRESS_STYLES for each stress id (the scoring engine indexes into these options)', () => {
  for (const id of STRESS_IDS) {
    const q = byId[id];
    const styles = STRESS_STYLES[id];
    assert.equal(
      q.options.length, styles.length,
      `id ${id}: quizQuestions.js has ${q.options.length} options but STRESS_STYLES has ${styles.length} — an index either scoring or the AI prompt reads would silently resolve to the wrong style/option text`,
    );
  }
});

test('no lifestyle/nervous-system-flavored leftovers on the stress ids (the specific regression)', () => {
  const bodies = STRESS_IDS.map((id) => `${byId[id].text} ${byId[id].options.join(' ')}`).join(' ').toLowerCase();
  assert.doesNotMatch(bodies, /thermostat|utility split|1 am with the light/);
});

test('the ordinal friction-topic map has no dead entries for the (categorical) stress ids', () => {
  // topFrictionTopic() only ever walks QUESTION_POINTS keys, which STRESS_IDS
  // are deliberately excluded from (stress is categorical, scored by the
  // clash matrix, not the ordinal diffScore loop) — so a FRICTION_TOPICS
  // entry for a stress id can never be selected. Pins that stale/wrong
  // labels don't quietly return.
  const { QUESTION_POINTS } = require('../services/scoring');
  for (const id of STRESS_IDS) {
    assert.ok(!(id in QUESTION_POINTS), `stress id ${id} should not be in the ordinal QUESTION_POINTS set`);
  }
});
