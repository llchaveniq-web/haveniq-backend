// Re-reading stored listings and retiring the ones the source dropped.
//
// The rule worth testing hardest is what does NOT count as gone. A 403 is
// about us, not the listing — retiring a student's options because a site
// started refusing our user agent would turn our problem into their empty
// screen. A timeout is weather. Only 404 and 410 are the source saying,
// unambiguously, that the posting is no longer there.
// node --test.
const test = require('node:test');
const assert = require('node:assert');
const { recheckListings } = require('./recheck');

function fakeDb(rows) {
  const writes = [];
  return {
    writes,
    query: async (sql, params = []) => {
      if (/SELECT[\s\S]*FROM listings/i.test(sql)) return { rows };
      writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rows: [] };
    },
  };
}

const L = (id, url) => ({ id, source: 'craigslist', source_url: url, address: `${id} Test St` });
const silent = () => {};

test('a live listing is stamped and left alone', async () => {
  const db = fakeDb([L('a', 'u/a')]);
  const stats = await recheckListings({ politeFetch: async () => ({ ok: true }), db, log: silent });
  assert.equal(stats.live, 1);
  assert.equal(stats.gone, 0);
  assert.equal(db.writes.length, 1);
  assert.match(db.writes[0].sql, /SET last_checked_at = now\(\)/);
  assert.doesNotMatch(db.writes[0].sql, /is_active/);
});

test('a 404 or 410 deactivates the listing and records when', async () => {
  for (const status of [404, 410]) {
    const db = fakeDb([L('a', 'u/a')]);
    const stats = await recheckListings({
      politeFetch: async () => ({ ok: false, status, gone: true }), db, log: silent,
    });
    assert.equal(stats.gone, 1, String(status));
    assert.match(db.writes[0].sql, /is_active = FALSE/);
    assert.match(db.writes[0].sql, /unavailable_at = now\(\)/);
  }
});

test('a gone listing is deactivated, never deleted', async () => {
  // Same reasoning as a rejected listing keeping its row: what was withdrawn,
  // and when, is worth being able to ask later.
  const db = fakeDb([L('a', 'u/a')]);
  await recheckListings({ politeFetch: async () => ({ ok: false, gone: true }), db, log: silent });
  assert.ok(db.writes.every(w => !/DELETE/i.test(w.sql)), 'must not delete');
});

test('a 403 does NOT retire the listing', async () => {
  // The site is refusing US. Turning that into an empty screen for a student
  // would be making our problem their problem.
  const db = fakeDb([L('a', 'u/a')]);
  const stats = await recheckListings({
    politeFetch: async () => ({ ok: false, status: 403, blocked: true }), db, log: silent,
  });
  assert.equal(stats.blocked, 1);
  assert.equal(stats.gone, 0);
  assert.deepEqual(db.writes, [], 'a blocked check must write nothing at all');
});

test('a timeout or 5xx does NOT retire the listing, and does not stamp it either', async () => {
  // Not stamping matters: a failed check has learned nothing, so the listing
  // must stay at the FRONT of the queue rather than going to the back as
  // though it had been verified.
  for (const res of [{ ok: false, error: 'timeout' }, { ok: false, status: 503 }]) {
    const db = fakeDb([L('a', 'u/a')]);
    const stats = await recheckListings({ politeFetch: async () => res, db, log: silent });
    assert.equal(stats.failed, 1);
    assert.equal(stats.gone, 0);
    assert.deepEqual(db.writes, []);
  }
});

test('the sweep takes the least recently checked first', async () => {
  const db = fakeDb([]);
  let seen = '';
  db.query = async (sql, params) => {
    if (/SELECT[\s\S]*FROM listings/i.test(sql)) { seen = sql; return { rows: [] }; }
    return { rows: [] };
  };
  await recheckListings({ politeFetch: async () => ({ ok: true }), db, log: silent });
  assert.match(seen, /last_checked_at ASC NULLS FIRST/);
  // Never-checked listings sort first, so a new arrival cannot be starved.
  assert.match(seen, /is_active = TRUE/);
  assert.match(seen, /source_url IS NOT NULL/);
});

test('it only ever looks at collected listings that are still live', async () => {
  // A student-posted listing has no source_url and is not ours to retire; an
  // already-inactive one has nothing left to learn.
  const db = fakeDb([]);
  let seen = '';
  db.query = async (sql) => { if (/SELECT/i.test(sql)) { seen = sql; } return { rows: [] }; };
  await recheckListings({ politeFetch: async () => ({ ok: true }), db, log: silent });
  assert.match(seen, /source_url IS NOT NULL[\s\S]*is_active = TRUE/);
});

test('an empty queue is a no-op rather than an error', async () => {
  const db = fakeDb([]);
  const stats = await recheckListings({ politeFetch: async () => ({ ok: true }), db, log: silent });
  assert.deepEqual(stats, { checked: 0, live: 0, gone: 0, blocked: 0, failed: 0 });
});

test('a mixed sweep reports each outcome separately', async () => {
  const db = fakeDb([L('a', 'u/a'), L('b', 'u/b'), L('c', 'u/c'), L('d', 'u/d')]);
  const byUrl = {
    'u/a': { ok: true },
    'u/b': { ok: false, gone: true },
    'u/c': { ok: false, blocked: true },
    'u/d': { ok: false, error: 'ETIMEDOUT' },
  };
  const stats = await recheckListings({ politeFetch: async (u) => byUrl[u], db, log: silent });
  assert.deepEqual(stats, { checked: 4, live: 1, gone: 1, blocked: 1, failed: 1 });
});

test('approved listings are swept before pending ones', async () => {
  // Staleness only reaches a student through an APPROVED listing. The first
  // live sweep spent all 100 of its checks on pending rows nobody could see,
  // because ordering on last_checked_at alone left every row tied at NULL.
  const db = fakeDb([]);
  let seen = '';
  db.query = async (sql) => { if (/SELECT/i.test(sql)) seen = sql; return { rows: [] }; };
  await recheckListings({ politeFetch: async () => ({ ok: true }), db, log: silent });
  assert.match(seen, /ORDER BY \(moderation_status = 'approved'\) DESC/);
  // And still least-recently-checked within each group.
  assert.match(seen, /last_checked_at ASC NULLS FIRST/);
});
