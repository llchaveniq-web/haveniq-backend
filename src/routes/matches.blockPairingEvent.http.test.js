// POST /matches/:matchId/block — pins that it stamps the 'block' funnel event
// into pairing_outcomes (services/pairingOutcomes.js), which
// services/dimensionModel.js's Loop B trainer needs to ever label a pair as a
// failure. Before this wiring, the trainer ran daily against zero labeled
// examples regardless of real block volume — a block succeeded but never
// reached the training pipeline. DB/auth/middleware stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let pairingInserts = [];
let pairingThrows = false;

inject('../db/pool', {
  query: async (sql, params) => {
    if (/INSERT INTO pairing_outcomes/.test(sql)) {
      if (pairingThrows) throw new Error('pairing_outcomes exploded');
      pairingInserts.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
    // user_blocks insert, connect_requests update, and everything else.
    return { rows: [], rowCount: 0 };
  },
  connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'blocker-1', school: 'Ohio University' }; next(); },
  refuseBanned: (_q, _s, n) => n(),
  optionalAuth: (_q, _s, n) => n(),
});
inject('../middleware/suspiciousActivity', { track: () => (_q, _s, n) => n() });
inject('../middleware/rateLimits', {
  aiLimiter: (_q, _s, n) => n(), writeReview: (_q, _s, n) => n(), submitRule: (_q, _s, n) => n(),
  submitNomination: (_q, _s, n) => n(), quickAction: (_q, _s, n) => n(), safetyReport: (_q, _s, n) => n(),
  safetyBlock: (_q, _s, n) => n(), writeLimiter: (_q, _s, n) => n(),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/matches', require('./matches'));

test.beforeEach(() => { pairingInserts = []; pairingThrows = false; });

test('a block stamps the pairing_outcomes block event, with the blocker/blocked ordered canonically', async () => {
  const res = await request(app).post('/matches/blocked-user-9/block').send({ reason: 'unsafe' });
  assert.equal(res.status, 200);
  assert.equal(res.body.blocked, true);
  // Give the fire-and-forget recordPairingEvent() a tick to run.
  await new Promise((r) => setImmediate(r));
  assert.equal(pairingInserts.length, 1);
  assert.match(pairingInserts[0].sql, /blocked_at/, 'block maps to the blocked_at column');
  const [a, b] = pairingInserts[0].params;
  assert.deepEqual([a, b].sort(), ['blocker-1', 'blocked-user-9'].sort(), 'canonical pair ordering');
});

test('a block still succeeds even if the pairing_outcomes write fails', async () => {
  pairingThrows = true;
  const res = await request(app).post('/matches/blocked-user-9/block').send({});
  assert.equal(res.status, 200, 'the block itself must never fail over best-effort logging');
  assert.equal(res.body.blocked, true);
});
