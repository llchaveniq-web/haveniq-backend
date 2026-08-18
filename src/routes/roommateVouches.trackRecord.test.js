// computeTrackRecord (docs/BACKEND_ROOMMATE_REPUTATION.md) — the honest
// aggregation over the mutual, verified roommate_vouches table. Locks: only
// status='confirmed' AND visibility='public' rows ever count (a pending
// request or a private confirmed vouch contributes NOTHING publicly — the
// about_user's consent gate is absolute); a would_live_again=false vouch
// still counts toward livedWithCount (neutral fact) but is never quoted or
// counted positive; zero qualifying rows returns null, not a zeroed object.
// node --test.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_thirty_two_chars_long_xxxx';
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let countRow = { lived_with_count: 0, would_live_again_count: 0 };
let quoteRows = [];
let lastCountSql = '';
let lastQuoteSql = '';

inject('../db/pool', {
  query: async (sql) => {
    if (/lived_with_count/.test(sql)) {
      lastCountSql = sql;
      return { rows: [countRow] };
    }
    if (/JOIN users u ON u\.id = rv\.from_user_id/.test(sql)) {
      lastQuoteSql = sql;
      return { rows: quoteRows };
    }
    return { rows: [] }; // ensureTables' CREATE/INDEX
  },
});

const { computeTrackRecord } = require('./roommateVouches');

test.beforeEach(() => {
  countRow = { lived_with_count: 0, would_live_again_count: 0 };
  quoteRows = [];
  lastCountSql = '';
  lastQuoteSql = '';
});

test('zero qualifying vouches → null, not a zeroed object', async () => {
  const record = await computeTrackRecord('11111111-1111-1111-1111-111111111111');
  assert.equal(record, null);
});

test('the count query is scoped to confirmed + public only', async () => {
  countRow = { lived_with_count: 1, would_live_again_count: 1 };
  await computeTrackRecord('11111111-1111-1111-1111-111111111111');
  assert.match(lastCountSql, /status = 'confirmed' AND visibility = 'public'/);
});

test('a would_live_again=false vouch still counts toward livedWithCount but never toward the positive count', async () => {
  countRow = { lived_with_count: 1, would_live_again_count: 0 };
  const record = await computeTrackRecord('11111111-1111-1111-1111-111111111111');
  assert.equal(record.livedWithCount, 1);
  assert.equal(record.wouldLiveAgainCount, 0);
  assert.equal(record.display, 'Lived with 1 roommate');
});

test('quotes include schoolYear now that the voucher is a real HavenIQ user', async () => {
  countRow = { lived_with_count: 1, would_live_again_count: 1 };
  quoteRows = [{ note: 'Kept the place spotless.', first_name: 'Priya', school_year: 'Junior' }];
  const record = await computeTrackRecord('11111111-1111-1111-1111-111111111111');
  assert.deepEqual(record.vouches, [
    { fromFirstName: 'Priya', note: 'Kept the place spotless.', schoolYear: 'Junior' },
  ]);
});

test('the quote query only reads would_live_again=TRUE rows — a negative is never surfaced as a quote', async () => {
  countRow = { lived_with_count: 2, would_live_again_count: 1 };
  await computeTrackRecord('11111111-1111-1111-1111-111111111111');
  assert.match(lastQuoteSql, /would_live_again = TRUE/);
});

test('all confirmed+public vouches positive → "all would live again"', async () => {
  countRow = { lived_with_count: 2, would_live_again_count: 2 };
  const record = await computeTrackRecord('11111111-1111-1111-1111-111111111111');
  assert.equal(record.display, 'Lived with 2 roommates · all would live again');
});
