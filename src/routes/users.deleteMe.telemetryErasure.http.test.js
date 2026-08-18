// DELETE /users/me — telemetry erasure integration.
//
// Found by audit: telemetry_events, pair_events, conflict_pulses, and
// user_profile_snapshot all use plain TEXT user_id columns with NO foreign
// key to users (see eraseUserTelemetry in telemetry.js), so the cascading
// FK deletes DELETE /users/me relies on for everything else never touched
// them. A deleted account's behavioral/longitudinal data — exactly the
// most sensitive rows — silently survived while the response told the
// student "your data has been permanently removed." Fixed by having
// DELETE /users/me call the same eraseUserTelemetry(...) function
// DELETE /telemetry/my-data uses, best-effort (a failure here must not
// block the user from deleting their account).
//
// pool mocked with a connect()-based client (eraseUserTelemetry runs a
// real transaction) so both the success and failure paths are exercised
// for real, not stubbed away. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let userDeleteCalls = [];
let clientQueries = [];
let connectShouldThrow = false;
let clientQueryShouldThrow = null; // table name substring to fail on, or null

inject('../db/pool', {
  query: async (sql, params) => {
    if (/DELETE FROM users WHERE id = \$1/.test(sql)) {
      userDeleteCalls.push(params);
      return { rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
  connect: async () => {
    if (connectShouldThrow) throw new Error('pool exhausted');
    return {
      query: async (sql, params) => {
        clientQueries.push({ sql, params });
        if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return {};
        if (clientQueryShouldThrow && sql.includes(clientQueryShouldThrow)) {
          throw new Error(`simulated failure on ${clientQueryShouldThrow}`);
        }
        return { rowCount: 3 };
      },
      release: () => {},
    };
  },
});

inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'u1', email: 'a@ohio.edu', is_banned: false }; next(); },
  refuseBanned: (_req, _res, next) => next(),
});

let reportedErrors = [];
inject('./sentryTunnel', {
  reportServerError: async (input) => { reportedErrors.push(input); },
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/users', require('./users'));

test.beforeEach(() => {
  userDeleteCalls = []; clientQueries = []; reportedErrors = [];
  connectShouldThrow = false; clientQueryShouldThrow = null;
});

test('deleting an account erases telemetry_events, pair_events, conflict_pulses, and user_profile_snapshot for that user', async () => {
  const res = await request(app).delete('/users/me');

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  const sqls = clientQueries.map(q => q.sql);
  assert.ok(sqls.some(s => /DELETE FROM telemetry_events WHERE user_id = \$1/.test(s)));
  assert.ok(sqls.some(s => /DELETE FROM user_profile_snapshot WHERE user_id = \$1/.test(s)));
  assert.ok(sqls.some(s => /DELETE FROM pair_events WHERE user_id = \$1/.test(s)));
  assert.ok(sqls.some(s => /DELETE FROM conflict_pulses WHERE user_id = \$1/.test(s)));
  // Scoped to the deleting user, not a table-wide wipe.
  for (const q of clientQueries) {
    if (/DELETE FROM/.test(q.sql)) assert.deepEqual(q.params, ['u1']);
  }
});

test('the erasure runs INSIDE a transaction (BEGIN before, COMMIT after, on success)', async () => {
  await request(app).delete('/users/me');
  const sqls = clientQueries.map(q => q.sql);
  assert.equal(sqls[0], 'BEGIN');
  assert.equal(sqls[sqls.length - 1], 'COMMIT');
});

test('account deletion still succeeds even if telemetry erasure fails entirely (best-effort, never blocks)', async () => {
  connectShouldThrow = true; // eraseUserTelemetry can't even get a client

  const res = await request(app).delete('/users/me');

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(userDeleteCalls.length, 1, 'the account row must still be deleted');
});

test('a failure partway through erasure (e.g. one DELETE throws) still lets account deletion proceed, and is reported', async () => {
  clientQueryShouldThrow = 'telemetry_events';

  const res = await request(app).delete('/users/me');

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(userDeleteCalls.length, 1);
  assert.equal(reportedErrors.length, 1, 'the failure must be reported, not silently swallowed');
  assert.match(reportedErrors[0].message, /telemetry erasure failed/);
  assert.equal(reportedErrors[0].userId, 'u1');
});

test('a failed erasure rolls back (no partial deletes committed) rather than leaving some tables cleaned and others not', async () => {
  clientQueryShouldThrow = 'pair_events';

  await request(app).delete('/users/me');

  const sqls = clientQueries.map(q => q.sql);
  assert.ok(sqls.includes('ROLLBACK'));
  assert.ok(!sqls.includes('COMMIT'));
});
