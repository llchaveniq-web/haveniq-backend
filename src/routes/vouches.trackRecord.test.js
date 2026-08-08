// computeTrackRecord — the honest, cheap-path trust-badge aggregation
// (docs/BACKEND_ROOMMATE_REPUTATION.md). Locks the semantics that matter:
// livedWithCount counts every APPROVED vouch regardless of the would-live-
// again answer (a neutral fact); wouldLiveAgainCount only counts explicit
// TRUE (never NULL/"never asked", never FALSE); a would_live_again=false
// vouch is never quoted and never treated as a negative; zero approved
// vouches returns null (not a zeroed object), so the frontend badge stays
// dark rather than rendering "Lived with 0 roommates". node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let quoteRows = [];
let countRow  = { lived_with_count: 0, would_live_again_count: 0 };
inject('../db/pool', {
  query: async (sql) => {
    // The two computeTrackRecord queries are distinguished by their SELECT
    // list, not incidental clauses — unambiguous regardless of formatting.
    if (/SELECT from_name, text/.test(sql)) return { rows: quoteRows };
    if (/lived_with_count/.test(sql))       return { rows: [countRow] };
    return { rows: [] }; // ensureTables' CREATE/ALTER/INDEX statements
  },
});

const { computeTrackRecord } = require('./vouches');

test.beforeEach(() => {
  quoteRows = [];
  countRow  = { lived_with_count: 0, would_live_again_count: 0 };
});

test('no approved vouches at all → null, not a zeroed object', async () => {
  const record = await computeTrackRecord('11111111-1111-1111-1111-111111111111');
  assert.equal(record, null);
});

test('approved vouches with no would_live_again answer still count toward livedWithCount', async () => {
  countRow = { lived_with_count: 2, would_live_again_count: 0 };
  const record = await computeTrackRecord('11111111-1111-1111-1111-111111111111');
  assert.equal(record.livedWithCount, 2);
  assert.equal(record.wouldLiveAgainCount, 0);
  assert.equal(record.display, 'Lived with 2 roommates');
  assert.deepEqual(record.vouches, []);
});

test('a would_live_again=false vouch counts as lived-with but is never quoted or counted positive', async () => {
  countRow = { lived_with_count: 1, would_live_again_count: 0 };
  quoteRows = []; // the SELECT itself filters to would_live_again = TRUE, so a false one never appears here
  const record = await computeTrackRecord('11111111-1111-1111-1111-111111111111');
  assert.equal(record.livedWithCount, 1);
  assert.equal(record.wouldLiveAgainCount, 0);
  assert.deepEqual(record.vouches, []);
});

test('all approved vouches said yes → "all would live again" phrasing, quotes included', async () => {
  countRow = { lived_with_count: 2, would_live_again_count: 2 };
  quoteRows = [
    { from_name: 'Jordan K.', text: 'Great about chores.' },
    { from_name: 'Sam T.', text: 'Quiet, respectful.' },
  ];
  const record = await computeTrackRecord('11111111-1111-1111-1111-111111111111');
  assert.equal(record.display, 'Lived with 2 roommates · all would live again');
  assert.deepEqual(record.vouches, [
    { fromFirstName: 'Jordan K.', note: 'Great about chores.' },
    { fromFirstName: 'Sam T.', note: 'Quiet, respectful.' },
  ]);
});

test('a partial positive split shows the exact count, not "all"', async () => {
  countRow = { lived_with_count: 3, would_live_again_count: 1 };
  const record = await computeTrackRecord('11111111-1111-1111-1111-111111111111');
  assert.equal(record.display, 'Lived with 3 roommates · 1 would live again');
});

test('a single roommate, single yes uses singular phrasing', async () => {
  countRow = { lived_with_count: 1, would_live_again_count: 1 };
  const record = await computeTrackRecord('11111111-1111-1111-1111-111111111111');
  assert.equal(record.display, 'Lived with 1 roommate · would live again');
});
