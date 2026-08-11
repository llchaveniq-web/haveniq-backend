// buildLabeledData() — the DB-reading half of the weight-learning pipeline.
// Locks the one thing labelPair's mutual moved_in_together requirement
// depends on entirely: each grouped row must carry the REAL reporter_id, not
// just the anonymized LEAST/GREATEST(a,b) pair key — otherwise labelPair has
// no way to tell "one person's claim, twice" from "two different people".
// pool stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

let outcomeRows = [];
let lastOutcomesSql = '';
inject('../db/pool', {
  query: async (sql) => {
    if (/FROM match_outcomes/.test(sql)) { lastOutcomesSql = sql; return { rows: outcomeRows }; }
    if (/FROM users u LEFT JOIN quiz_answers/.test(sql)) {
      return { rows: [{ id: A, school: 'UCLA', answers: {} }, { id: B, school: 'UCLA', answers: {} }] };
    }
    return { rows: [] };
  },
});

const { buildLabeledData } = require('./weightAnalyst');

test.beforeEach(() => { outcomeRows = []; lastOutcomesSql = ''; });

test('the SQL selects reporter_id directly, not just the anonymized LEAST/GREATEST pair key', async () => {
  // A regression on the query itself would silently break the mutual
  // requirement without any other test failing — assert on the query shape
  // directly, not just the end-to-end row output.
  await buildLabeledData();
  assert.match(lastOutcomesSql, /\breporter_id\b/);
});

test('a unilateral moved_in_together claim from one reporter, even with a positive retention row, is not labeled "worked"', async () => {
  outcomeRows = [
    { a: A, b: B, reporter_id: A, outcome: 'moved_in_together', details: null },
    { a: A, b: B, reporter_id: A, outcome: 'survey_60d', details: { stage: 'day60', answer: 'yes' } },
  ];
  const { pairs } = await buildLabeledData();
  assert.equal(pairs.length, 0, 'too-early/unknown pairs are excluded from training entirely');
});

test('a mutually confirmed moved_in_together (two distinct reporter_ids) + retention IS labeled "worked"', async () => {
  outcomeRows = [
    { a: A, b: B, reporter_id: A, outcome: 'moved_in_together', details: null },
    { a: A, b: B, reporter_id: B, outcome: 'moved_in_together', details: null },
    { a: A, b: B, reporter_id: A, outcome: 'survey_60d', details: { stage: 'day60', answer: 'yes' } },
  ];
  const { pairs } = await buildLabeledData();
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].label, 'worked');
  assert.deepEqual([pairs[0].aId, pairs[0].bId].sort(), [A, B].sort());
});
