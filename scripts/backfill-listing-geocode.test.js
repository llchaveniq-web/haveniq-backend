// backfill-listing-geocode — the loop, with a stub pool and stub geocoder.
//
// A backfill is a script someone runs once against production data, half-reads
// the output of, and never thinks about again. So the things worth pinning are
// the ones that would quietly corrupt or under-fill without anyone noticing:
// which rows it selects, what it writes when an address can't be resolved,
// whether one bad row abandons the rest of the run, and whether --dry-run
// really writes nothing.
//
// node --test.
const test = require('node:test');
const assert = require('node:assert');

const { backfill } = require('./backfill-listing-geocode');

function stubDb(rows) {
  const writes = [];
  const selects = [];
  return {
    writes,
    selects,
    query: async (sql, params = []) => {
      if (/^\s*UPDATE/i.test(sql)) { writes.push({ sql, params }); return { rows: [] }; }
      selects.push(sql);
      return { rows };
    },
  };
}

const ROW = (id, address = '412 Bardeen Ave') => ({
  id, address, city: 'Irvine', school_near: 'UC Irvine',
});

const silent = () => {};

test('writes coordinates for every listing it can locate', async () => {
  const db = stubDb([ROW('l-1'), ROW('l-2')]);
  const stats = await backfill({
    db,
    geocode: async () => ({ lat: 33.64, lon: -117.84 }),
    log: silent,
  });

  assert.equal(stats.located, 2);
  assert.equal(db.writes.length, 2);
  assert.deepEqual(db.writes[0].params, ['l-1', 33.64, -117.84]);
});

test('stamps a miss with NULL coordinates so it is never retried', async () => {
  // The whole point of geocoded_at. Without the stamp, an address Nominatim
  // will never resolve gets re-attempted on every future run, forever.
  const db = stubDb([ROW('l-1')]);
  const stats = await backfill({ db, geocode: async () => null, log: silent });

  assert.equal(stats.missed, 1);
  assert.equal(db.writes.length, 1);
  assert.deepEqual(db.writes[0].params, ['l-1', null, null]);
  assert.match(db.writes[0].sql, /geocoded_at = now\(\)/);
});

test('selects only rows that have never been attempted', async () => {
  const db = stubDb([]);
  await backfill({ db, geocode: async () => null, log: silent });
  assert.match(db.selects[0], /geocoded_at IS NULL/);
});

test('--retry-misses targets stamped rows that still have no coordinates', async () => {
  const db = stubDb([]);
  await backfill({ db, geocode: async () => null, retryMisses: true, log: silent });
  assert.match(db.selects[0], /geocoded_at IS NOT NULL AND latitude IS NULL/);
});

test('skips listings with a blank address rather than geocoding ""', async () => {
  const db = stubDb([]);
  await backfill({ db, geocode: async () => null, log: silent });
  assert.match(db.selects[0], /btrim\(address\) <> ''/);
});

test('dry run writes absolutely nothing', async () => {
  const db = stubDb([ROW('l-1'), ROW('l-2')]);
  const stats = await backfill({
    db, geocode: async () => ({ lat: 1, lon: 2 }), dryRun: true, log: silent,
  });

  assert.equal(stats.located, 2, 'still reports what it would do');
  assert.equal(db.writes.length, 0, 'but touches nothing');
});

test('one exploding row does not abandon the rest of the run', async () => {
  const db = stubDb([ROW('l-1'), ROW('l-2'), ROW('l-3')]);
  let n = 0;
  const stats = await backfill({
    db,
    geocode: async () => {
      n += 1;
      if (n === 2) throw new Error('socket hang up');
      return { lat: 1, lon: 2 };
    },
    log: silent,
  });

  assert.equal(stats.failed, 1);
  assert.equal(stats.located, 2);
  assert.equal(db.writes.length, 2, 'the other two were still written');
});

test('a failed write is counted, not swallowed', async () => {
  // The exit code keys off stats.failed, so a write failure that didn't count
  // would make a partly-failed backfill look like a clean one.
  const db = {
    query: async (sql) => {
      if (/^\s*UPDATE/i.test(sql)) throw new Error('deadlock detected');
      return { rows: [ROW('l-1')] };
    },
  };
  const stats = await backfill({ db, geocode: async () => ({ lat: 1, lon: 2 }), log: silent });
  assert.equal(stats.failed, 1);
});

test('an empty table is a no-op, not an error', async () => {
  const db = stubDb([]);
  const stats = await backfill({ db, geocode: async () => null, log: silent });
  assert.deepEqual(stats, { total: 0, located: 0, missed: 0, failed: 0 });
  assert.equal(db.writes.length, 0);
});

test('--limit is a number, and reaches the query', async () => {
  const db = stubDb([]);
  await backfill({ db, geocode: async () => null, limit: 20, log: silent });
  assert.match(db.selects[0], /LIMIT 20/);
});
