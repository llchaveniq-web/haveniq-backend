'use strict';

// GET /matches/feed's candidate SQL ran `ORDER BY cs.score DESC LIMIT 50`,
// then applied the JS-side viability filter (isViable) AFTER that limit. A
// large school with more than 50 eligible candidates could have real hard
// budget/move-in conflicts among the top 50 by score, shrinking the visible
// feed even though viable, lower-scored candidates existed just past the old
// cutoff. Also, ties on cs.score at the limit boundary had no deterministic
// secondary sort, so which candidates actually landed in the top-N could
// change between otherwise-identical requests. Both fixed by raising the
// fetch cap well above the ~30-user typical campus pool and adding u.id as a
// stable tiebreaker. Source-regex check since this query needs a real DB (or
// an elaborate multi-join pool mock no other test in this file attempts) to
// exercise end-to-end.

process.env.JWT_SECRET = process.env.JWT_SECRET
  || require('crypto').randomBytes(48).toString('hex');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'matches.js'), 'utf8');

test('the feed query fetches a pool larger than the typical ~30-user campus size before viability-filtering', () => {
  const capMatch = src.match(/const FEED_POOL_CAP = (\d+);/);
  assert.ok(capMatch, 'FEED_POOL_CAP constant not found');
  const cap = parseInt(capMatch[1], 10);
  assert.ok(cap >= 100, `FEED_POOL_CAP (${cap}) should have real headroom over a ~30-user campus pool`);
});

test('the feed query orders by score with a deterministic tiebreaker, not score alone', () => {
  assert.match(src, /ORDER BY cs\.score DESC, u\.id\s*\n\s*LIMIT \$\{FEED_POOL_CAP\}/);
});

test('viability filtering still runs after the (now larger) SQL fetch, not instead of it', () => {
  // Guards against a future edit collapsing FEED_POOL_CAP back down without
  // also reasoning about the isViable() filter that runs on its output.
  const feedIdx = src.indexOf("router.get('/feed'");
  const limitIdx = src.indexOf('LIMIT ${FEED_POOL_CAP}', feedIdx);
  const filterIdx = src.indexOf('rows.filter(r => isViable(', feedIdx);
  assert.ok(feedIdx >= 0 && limitIdx > feedIdx && filterIdx > limitIdx);
});
