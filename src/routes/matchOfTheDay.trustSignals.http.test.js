// GET /matches/today — the trust signals the daily card renders.
//
// The client's TrustChips proves the strongest verification tier it can from
// what this endpoint hands it: identityVerifiedAt -> "ID verified", otherwise
// isVerified -> ".edu verified". Before this, /matches/today returned only
// isVerified, so the daily pick could show nothing better than the weakest
// badge even for a student who had completed Stripe Identity and earned
// past-roommate vouches.
//
// Two things are load-bearing here and both are tested:
//
//   1. The real signals are returned. identityVerifiedAt and vouchCount come
//      from actual columns/rows — identity_verified_at on users, and approved
//      rows in the vouches table.
//
//   2. A MISSING vouches table cannot break the card. That table is not in
//      schema.sql; routes/vouches.js creates it lazily behind an in-process
//      `ready` flag the first time anyone touches a vouch route. On a freshly
//      migrated database nobody has, so a naive join from here would throw
//      `relation "vouches" does not exist` and take the whole daily match down
//      for every student — to add one badge. The count is isolated in its own
//      guarded query; a missing table degrades to zero vouches.
//
// Deliberately NOT returned: trustTier. The client type calls it "HavenIQ's
// primary anti-scammer defense", but no column, query or job in this backend
// produces one. Inventing a tier here would be the unearned claim TrustChips
// exists to refuse. node --test.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_thirty_two_chars_long_xxxx';
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── Mutable fixtures ──────────────────────────────────────────────────────
let userRow = null;
let vouchesTableExists = true;
let approvedVouches = 0;
let vouchQueries = 0;

inject('../db/pool', {
  query: async (sql, params = []) => {
    if (/FROM vouches/i.test(sql)) {
      vouchQueries++;
      if (!vouchesTableExists) {
        const e = new Error('relation "vouches" does not exist');
        e.code = '42P01';
        throw e;
      }
      return { rows: [{ n: approvedVouches }] };
    }
    if (/FROM match_of_the_day/i.test(sql)) {
      return { rows: [{ match_user_id: 'u-match', action: 'pending' }] };
    }
    if (/FROM users u/i.test(sql)) {
      return { rows: userRow ? [userRow] : [] };
    }
    return { rows: [] };            // CREATE TABLE / INSERT / everything else
  },
});

inject('../middleware/auth', {
  requireAuth:  (req, res, next) => { req.user = { id: 'u-me' }; next(); },
  optionalAuth: (req, res, next) => { req.user = { id: 'u-me' }; next(); },
});
inject('../middleware/rateLimits', new Proxy({}, { get: () => (req, res, next) => next() }));

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/matches', require('./matchOfTheDay'));

const baseUser = {
  id: 'u-match', first_name: 'Priya', last_name: 'Sharma',
  school: 'UCLA', school_year: 'Senior', major: 'Design', bio: 'hi',
  photo_url: null, is_verified: true, identity_verified_at: null,
  photo_urls: null, score: 91, breakdown: {}, why_matched: null,
};

test.beforeEach(() => {
  userRow = { ...baseUser };
  vouchesTableExists = true;
  approvedVouches = 0;
  vouchQueries = 0;
});

// ── 1. The real signals reach the card ────────────────────────────────────
test('an ID-verified student’s identityVerifiedAt reaches the daily card', async () => {
  userRow.identity_verified_at = '2026-05-01T00:00:00.000Z';
  const res = await request(app).get('/matches/today');
  assert.equal(res.status, 200);
  assert.equal(res.body.match.identityVerifiedAt, '2026-05-01T00:00:00.000Z',
    'without this the card can never show better than ".edu verified"');
});

test('approved vouches are counted; pending/rejected are the query’s problem, not ours', async () => {
  approvedVouches = 3;
  const res = await request(app).get('/matches/today');
  assert.equal(res.body.match.vouchCount, 3);
  assert.equal(vouchQueries, 1, 'exactly one vouch lookup per hydrate');
});

test('no vouches yields 0, never null or undefined', async () => {
  approvedVouches = 0;
  const res = await request(app).get('/matches/today');
  assert.strictEqual(res.body.match.vouchCount, 0);
});

test('a student with neither signal still returns them explicitly', async () => {
  const res = await request(app).get('/matches/today');
  assert.strictEqual(res.body.match.identityVerifiedAt, null);
  assert.strictEqual(res.body.match.vouchCount, 0);
});

// ── 2. A missing vouches table must not break the card ────────────────────
test('a missing vouches table degrades to zero instead of 500ing the daily match', async () => {
  vouchesTableExists = false;       // fresh DB: routes/vouches.js never ran
  const res = await request(app).get('/matches/today');
  assert.equal(res.status, 200, 'the daily card must survive a missing table');
  assert.equal(res.body.match.vouchCount, 0);
  assert.equal(res.body.match.firstName, 'Priya', 'the rest of the card is intact');
});

// ── 3. No invented tier ───────────────────────────────────────────────────
test('trustTier is not fabricated — nothing in this backend produces one', async () => {
  userRow.identity_verified_at = '2026-05-01T00:00:00.000Z';
  const res = await request(app).get('/matches/today');
  assert.ok(!('trustTier' in res.body.match),
    'returning a tier no column computes would be an unearned claim');
});
