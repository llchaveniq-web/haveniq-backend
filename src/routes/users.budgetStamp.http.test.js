// PATCH /users/me must stamp budget_set_at only when the budget actually MOVED.
//
// The stamp is what separates a chosen range from schema.sql's DEFAULT 500/2000
// (see 05dfd82). An UNCONDITIONAL stamp would immediately start lying the other
// way, because the client sends this pair whether or not the student touched it:
// app/(setup)/edit-profile.tsx step 3 says "sent unconditionally exactly as
// hydrated from the account". A student who never set a budget hydrates
// 500/2000, walks through the profile form, and gets stamped as having chosen
// it. That is worse than the bug the stamp fixes: the old lie was detectable as
// the default; a stamped one is indistinguishable from a real answer forever.
//
// Postgres evaluates SET expressions against the OLD row, so the CASE can
// compare stored against incoming inside the same UPDATE. Verified against
// 16.13: re-sending 500/2000 leaves budget_set_at NULL, moving to 800/1200
// stamps it.
process.env.JWT_SECRET = process.env.JWT_SECRET
  || require('crypto').randomBytes(48).toString('hex');

const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let lastSql = '';
let lastValues = [];
inject('../db/pool', {
  query: async (sql, values) => {
    if (/^\s*UPDATE users/i.test(sql)) { lastSql = sql; lastValues = values || []; }
    return { rows: [{ id: 'u1', email: 'a@b.edu', budget_min: 800, budget_max: 1200 }] };
  },
});
// refuseBanned too: the router imports both, and stubbing only requireAuth
// leaves the other undefined, which express rejects with
// "argument handler must be a function" -- a failure that looks nothing like
// its cause.
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'u1' }; next(); },
  refuseBanned: (_req, _res, next) => next(),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/users', require('./users'));

const patch = (body) => request(app).patch('/users/me').send(body);

test('a budget PATCH stamps CONDITIONALLY, never with a bare NOW()', async () => {
  lastSql = '';
  await patch({ budgetMin: 800, budgetMax: 1200 });
  assert.match(lastSql, /budget_set_at = CASE WHEN/,
    'the stamp must be conditional on the value having moved');
  assert.ok(!/budget_set_at = NOW\(\)/.test(lastSql),
    'an unconditional stamp mints an answer the student never gave');
  // Both columns compared, and against the SENT values.
  assert.match(lastSql, /budget_min IS DISTINCT FROM \$\d+/);
  assert.match(lastSql, /budget_max IS DISTINCT FROM \$\d+/);
  assert.ok(lastValues.includes(800) && lastValues.includes(1200));
});

test('IS DISTINCT FROM, not <>, because either column can be NULL', async () => {
  lastSql = '';
  await patch({ budgetMin: 800, budgetMax: 1200 });
  // NULL <> 800 is NULL, not true, so <> would silently fail to stamp the
  // first budget a student ever sets if the column were null.
  assert.ok(!/budget_min <> /.test(lastSql));
});

test('one half sent alone compares only that half', async () => {
  lastSql = '';
  await patch({ budgetMin: 900 });
  assert.match(lastSql, /budget_min IS DISTINCT FROM \$\d+/);
  assert.ok(!/budget_max IS DISTINCT FROM/.test(lastSql),
    'budget_max was not sent, so comparing it would stamp on a value nobody supplied');
});

test('a PATCH with no budget does not touch the stamp at all', async () => {
  lastSql = '';
  await patch({ bio: 'hello there, this is a bio' });
  assert.ok(!/budget_set_at/.test(lastSql));
});

test('the move-in stamp stays unconditional, which is correct for it', async () => {
  // moveInTimeline is only ever sent when the student picks one, so there is no
  // hydrate-and-resend path to defend against. Pinned so the two rules are not
  // "fixed" into agreeing with each other.
  lastSql = '';
  await patch({ moveInTimeline: 'this_month' });
  assert.match(lastSql, /move_in_set_at = NOW\(\)/);
});
