// COLLECT_TARGETS parsing.
//
// This was inline in server.js and silently truncated "University of
// California, Los Angeles" to "University of California" — a school no student
// has — because the target list was comma-separated and the school name
// contains a comma. The collector then filed listings under a school nobody
// matched, and the housing tab stayed empty with nothing in the logs.
//
// The failure mode worth testing is not "does it parse" but "does it refuse
// rather than half-parse". A truncated school looks exactly like a working one.
// node --test.
const test = require('node:test');
const assert = require('node:assert');
const { parseCollectTargets } = require('./collectTargets');

test('semicolons let a school name keep its comma', () => {
  const { targets, rejected } = parseCollectTargets(
    'craigslist:lax:University of California, Los Angeles;uloop:usc:University of Southern California');
  assert.deepEqual(rejected, []);
  assert.deepEqual(targets, [
    { source: 'craigslist', region: 'lax', school: 'University of California, Los Angeles' },
    { source: 'uloop', region: 'usc', school: 'University of Southern California' },
  ]);
});

test('commas still work for names that do not contain one', () => {
  // Existing config must keep running; the separator is chosen per value.
  const { targets } = parseCollectTargets('craigslist:orc:Orange Coast College,uloop:occ:Orange Coast College');
  assert.equal(targets.length, 2);
  assert.equal(targets[0].school, 'Orange Coast College');
});

test('a comma-split school name is put back together, not truncated', () => {
  // The actual bug. Splitting on ',' gives "craigslist:lax:University of
  // California" plus a stray " Los Angeles". The first half parses cleanly and
  // is WRONG — a school no student has — which is worse than failing outright.
  // A fragment with no source:region: prefix belongs to the school before it.
  const { targets, rejected } = parseCollectTargets('craigslist:lax:University of California, Los Angeles');
  assert.deepEqual(rejected, []);
  assert.deepEqual(targets, [
    { source: 'craigslist', region: 'lax', school: 'University of California, Los Angeles' },
  ]);
});

test('recovery does not glue a fragment onto an unrelated later target', () => {
  const { targets } = parseCollectTargets(
    'craigslist:lax:University of California, Los Angeles,uloop:occ:Orange Coast College');
  assert.equal(targets.length, 2);
  assert.equal(targets[0].school, 'University of California, Los Angeles');
  assert.equal(targets[1].school, 'Orange Coast College');
});

test('malformed entries are reported rather than dropped in silence', () => {
  const { targets, rejected } = parseCollectTargets('uloop:usc:USC;garbage;uloop:;:region:school');
  assert.equal(targets.length, 1);
  assert.deepEqual(rejected, ['garbage', 'uloop:', ':region:school']);
});

test('a school name may contain colons; only the first two split', () => {
  const { targets } = parseCollectTargets('uloop:x:Wossamotta U: The Sequel');
  assert.equal(targets[0].school, 'Wossamotta U: The Sequel');
});

test('empty, whitespace and undefined yield nothing rather than throwing', () => {
  for (const raw of ['', '   ', ';;;', undefined, null]) {
    const { targets } = parseCollectTargets(raw);
    assert.deepEqual(targets, [], JSON.stringify(raw));
  }
});

test('surrounding whitespace is trimmed from every part', () => {
  const { targets } = parseCollectTargets('  craigslist : lax : UCLA  ;  uloop:occ:Orange Coast College ');
  assert.deepEqual(targets[0], { source: 'craigslist', region: 'lax', school: 'UCLA' });
  assert.equal(targets[1].school, 'Orange Coast College');
});
