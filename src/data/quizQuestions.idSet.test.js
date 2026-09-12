// The header comment and the data underneath it must agree.
//
// quizQuestions.js is the backend's lookup from question id to question TEXT,
// and every AI feature that shows a student their own words reads it: the
// About You personality reveal (services/personality.js) and the Matched
// Moment reveal (routes/matchedMoment.js). An id missing from this file is not
// an error anywhere. personality.js iterates the file and skips what it does
// not have; matchedMoment.js does `if (!q) return null`. The answer is simply
// absent from the prompt, and the model writes a confident read of the student
// without it.
//
// That is what happened to Q76, the pets question. The app added it as the
// eighteenth scored question, the backend's own matching code reads
// answers->'76' for the pet hard filter (routes/matches.js), and this mirror
// never got the text — so two students who both answered "Yes, I have one"
// could not be told they agreed on it, under a prompt that opens "Both took an
// 18-question compatibility quiz".
//
// The count in the header was then corrected from 17 to 18 while the file
// still held seventeen entries, which made the comment assert a question that
// was not there. A number in prose is not a check.
//
// So this parses the enumeration in the header itself and compares it to the
// entries below. The two cannot drift apart without failing, and whoever edits
// one is told to edit the other. node --test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'quizQuestions.js'), 'utf8');
const QUIZ_QUESTIONS = require('./quizQuestions');

// The header writes ids the way a person reads them: "14, 48–57, 60, 62, 63,
// 65–67, 76", with en-dashes for runs. Expand it to the set it describes.
function idsFromHeader(src) {
  const line = src.match(/constants\/quiz\.ts SCORED_IDS:([\s\S]*?)\(/);
  assert.ok(line, 'the header no longer enumerates SCORED_IDS, so nothing here is being checked');
  const text = line[1].replace(/\n\s*\/\/\s*/g, ' ');
  const ids = new Set();
  for (const part of text.split(',')) {
    const run = part.trim().match(/^(\d+)\s*[–—-]\s*(\d+)$/);
    if (run) {
      for (let i = Number(run[1]); i <= Number(run[2]); i++) ids.add(i);
      continue;
    }
    const one = part.trim().match(/^(\d+)$/);
    if (one) ids.add(Number(one[1]));
  }
  return ids;
}

test('the header enumeration is still parseable, so this test can fail', () => {
  // Without this the two assertions below can both pass over an empty set,
  // which is the shape of check this file exists to argue against.
  const ids = idsFromHeader(SRC);
  assert.ok(ids.size >= 15, `parsed only ${ids.size} ids from the header enumeration`);
  assert.ok(ids.has(14), 'expected id 14 in the header enumeration');
  assert.ok(ids.has(76), 'expected id 76 (pets) in the header enumeration');
});

test('every id the header claims is actually in the file', () => {
  const claimed = idsFromHeader(SRC);
  const present = new Set(QUIZ_QUESTIONS.map((q) => q.id));
  const missing = [...claimed].filter((id) => !present.has(id));
  assert.deepEqual(missing, [],
    `the header says these ids are mirrored here and they are not: ${missing.join(', ')}. `
    + 'Add the question text, or correct the header. Every AI prompt that renders a '
    + "student's own answers silently drops an id this file does not have.");
});

test('every id in the file is one the header claims', () => {
  const claimed = idsFromHeader(SRC);
  const extra = QUIZ_QUESTIONS.map((q) => q.id).filter((id) => !claimed.has(id));
  assert.deepEqual(extra, [],
    `these ids are mirrored here but the header does not list them: ${extra.join(', ')}`);
});

test('the count named in the header matches the entries', () => {
  const stated = SRC.match(/It mirrors the (\d+) questions the app actually asks/);
  assert.ok(stated, 'the header no longer states a question count');
  assert.equal(Number(stated[1]), QUIZ_QUESTIONS.length,
    `the header says ${stated[1]} questions and the file holds ${QUIZ_QUESTIONS.length}`);
});

test('every entry can actually be rendered into a prompt', () => {
  // A malformed entry fails the same way a missing one does, silently, because
  // both consumers guard with `if (choice === undefined) continue`.
  for (const q of QUIZ_QUESTIONS) {
    assert.equal(typeof q.id, 'number', `entry has no numeric id: ${JSON.stringify(q).slice(0, 60)}`);
    assert.ok(q.text && q.text.trim().length > 4, `id ${q.id} has no usable text`);
    assert.ok(q.category && q.category.trim(), `id ${q.id} has no category`);
    assert.ok(Array.isArray(q.options) && q.options.length >= 2,
      `id ${q.id} needs at least two options to render a choice`);
    for (const o of q.options) {
      assert.ok(typeof o === 'string' && o.trim(), `id ${q.id} has an empty option`);
    }
  }
});

test('no id is mirrored twice', () => {
  const ids = QUIZ_QUESTIONS.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(', ')}`);
});
