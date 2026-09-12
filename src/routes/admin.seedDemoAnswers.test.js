// The demo seeder must answer the questions students are actually asked.
//
// POST /admin/seed-demos creates the demo accounts that appear in real
// students' match feeds — that is stated as the reason the quiz_answers INSERT
// exists at all, since the feed JOINs compatibility_scores and those rows need
// quiz answers to exist.
//
// It seeded from a list of ids copied next to the code. The list had gone stale
// in both directions: 24 ids under a comment claiming 26, of which only six
// (14, 50, 54, 55, 57, 60) are still scored. The other eighteen are dead ids
// from the pre-2026 60-question set that no student can answer, and twelve of
// the eighteen live questions got no answer at all.
//
// scoring.js counts a question toward maxScore only when BOTH users answered
// it, so a demo seeded that way scored against a real student on at most six of
// eighteen questions and still displayed an ordinary-looking percentage.
//
// The seeder now derives its ids from data/quizQuestions.js. This pins that,
// and pins the index range, which also has to be right per question: the old
// code clamped every answer to 0-2 to stay safe for 3-option questions, so no
// demo account could ever express 'suppress' or 'control' on Q65, two of the
// five coping styles the stress clash matrix scores. node --test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'admin.js'), 'utf8');
const QUIZ_QUESTIONS = require('../data/quizQuestions');
const { STRESS_STYLES, QUESTION_POINTS } = require('../services/scoring');

test('the seeder derives its ids from the quiz mirror, not a copied list', () => {
  // A hardcoded array of ids next to this code is the thing that went stale.
  assert.match(SRC, /const QUIZ_IDS = QUIZ_QUESTIONS\.map\(q => q\.id\)/,
    'seed-demos should take its question ids from data/quizQuestions.js');
  assert.match(SRC, /require\('\.\.\/data\/quizQuestions'\)/,
    'admin.js should require the quiz mirror');
});

test('no literal list of quiz ids is left in the seeder', () => {
  // The specific stale list, so re-introducing it fails rather than passing
  // quietly beside the derived one.
  assert.ok(!SRC.includes('[1,3,9,14,15,17,22,25,29,31,32,33,35,37,38,42,45,47,50,54,55,57,58,60]'),
    'the stale 24-id list is back in admin.js');
});

test('every generated index is in range for the scorer that reads it', () => {
  // Rebuild exactly what the route builds, then check the largest index each
  // expression can produce against whichever scorer handles that question.
  const expr = QUIZ_QUESTIONS
    .map(q => `'${q.id}', (random() * ${Math.max(0, q.options.length - 1)})::INT`)
    .join(', ');

  const pairs = [...expr.matchAll(/'(\d+)', \(random\(\) \* (\d+)\)::INT/g)]
    .map(m => ({ id: Number(m[1]), maxIdx: Number(m[2]) }));
  assert.equal(pairs.length, QUIZ_QUESTIONS.length, 'every question should get an expression');

  for (const { id, maxIdx } of pairs) {
    const q = QUIZ_QUESTIONS.find(x => x.id === id);
    assert.equal(maxIdx, q.options.length - 1,
      `id ${id} generates up to index ${maxIdx} but has ${q.options.length} options`);

    // Stress ids are scored categorically by the clash matrix, so the style
    // list is the real bound there, not the option list.
    if (STRESS_STYLES[id]) {
      assert.equal(STRESS_STYLES[id].length, q.options.length,
        `id ${id}: the mirror has ${q.options.length} options but the clash matrix `
        + `knows ${STRESS_STYLES[id].length} styles`);
    }
  }
});

test('the seeded set covers the ordinal questions that actually score', () => {
  // Every id carrying points, except the ones deliberately staged ahead of the
  // app (they have points here but are not in SCORED_IDS yet, by design).
  const seeded = new Set(QUIZ_QUESTIONS.map(q => q.id));
  const pointed = Object.keys(QUESTION_POINTS).map(Number);
  const uncovered = pointed.filter(id => !seeded.has(id));
  assert.deepEqual(uncovered, [68],
    `expected only the staged id 68 to carry points without being asked; got ${uncovered.join(', ')}`);
});

test('every stress id is seeded, since they score categorically', () => {
  const seeded = new Set(QUIZ_QUESTIONS.map(q => q.id));
  for (const id of Object.keys(STRESS_STYLES).map(Number)) {
    assert.ok(seeded.has(id), `stress id ${id} is scored but would never be answered by a demo`);
  }
});
