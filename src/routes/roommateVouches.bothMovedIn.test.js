// bothMovedInTogether — the STRONGER mutual-confirmation bar above
// everMovedInTogether's one-sided minimum. Locks: requires BOTH directions
// present (a one-sided report is not enough), and is a real AND, not an OR
// mistakenly copy-pasted from the request gate. node --test.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_thirty_two_chars_long_xxxx';
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let aReported = false;
let bReported = false;
inject('../db/pool', {
  query: async (sql) => {
    if (/a_reported/.test(sql)) return { rows: [{ a_reported: aReported, b_reported: bReported }] };
    return { rows: [] };
  },
});

const { bothMovedInTogether } = require('./roommateVouches');

test.beforeEach(() => { aReported = false; bReported = false; });

test('neither side reported → false', async () => {
  assert.equal(await bothMovedInTogether('u1', 'u2'), false);
});

test('only one side reported → still false (this is the whole point)', async () => {
  aReported = true;
  assert.equal(await bothMovedInTogether('u1', 'u2'), false);
  aReported = false; bReported = true;
  assert.equal(await bothMovedInTogether('u1', 'u2'), false);
});

test('both sides reported → true', async () => {
  aReported = true; bReported = true;
  assert.equal(await bothMovedInTogether('u1', 'u2'), true);
});
