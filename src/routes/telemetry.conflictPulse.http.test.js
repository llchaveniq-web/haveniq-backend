// POST /telemetry/batch conflict_pulse side-channel + GET /conflict-pulse/:matchId
// join route. Pins that conflict_pulse is routed to its own conflict_pulses table
// (NOT telemetry_events), can't take a student's batch down, reports its counters
// truthfully, and that the join route reads the counterpart's rows back.
// DB/auth stubbed (CI-safe — no live Postgres). Mirrors telemetry.pairEvents.http.test.js.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let telemetryInserts = [];
let cpInserts = [];
let cpInsertThrows = false;
let cpSelectRows = [];   // what freshReads' SELECT returns

inject('../db/pool', {
  connect: async () => ({
    query: async (sql, params) => {
      if (/INSERT INTO telemetry_events/.test(sql)) telemetryInserts.push(params);
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  }),
  query: async (sql, params) => {
    if (/INSERT INTO conflict_pulses/.test(sql)) {
      if (cpInsertThrows) throw new Error('conflict_pulses table exploded');
      cpInserts.push(params);
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT .* FROM conflict_pulses/is.test(sql)) {
      return { rows: cpSelectRows };
    }
    // CREATE TABLE / CREATE INDEX (ensureTable) and everything else.
    return { rows: [], rowCount: 0 };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'user-A', email: 'a@ohio.edu' }; next(); },
  refuseBanned: (_q, _s, n) => n(),
});
inject('../services/email', { sendNewMessageEmail: async () => {}, sendSupportAckEmail: async () => {} });

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/telemetry', require('./telemetry'));
app.use('/conflict-pulse', require('./conflictPulseJoin'));

const cpEvt = (id, over) => ({
  id, type: 'conflict_pulse', category: 'longitudinal', timestamp: over?.at ?? 100,
  payload: { matchId: 'user-B', topic: 'guests', level: 1, raised: false, at: 100, ...(over || {}) },
});
const moodEvt = (id) => ({ id, type: 'mood_entry', category: 'wellbeing', timestamp: 1, payload: { mood: 3 } });
const post = (events) => request(app).post('/telemetry/batch').send({ deviceId: 'dev-1', events });

test.beforeEach(() => {
  telemetryInserts = []; cpInserts = []; cpInsertThrows = false; cpSelectRows = [];
  require('../services/conflictPulses')._resetTableReady();
});

test('a conflict_pulse is routed to conflict_pulses, NOT telemetry_events', async () => {
  const res = await post([cpEvt('c1')]);
  assert.equal(res.status, 200);
  assert.equal(cpInserts.length, 1);
  assert.equal(telemetryInserts.length, 0, 'must not double-write into the generic blob');
  assert.deepEqual(res.body.conflictPulses, { stored: 1, dropped: 0 });
});

test('conflict_pulses are not counted as dropped (they were stored)', async () => {
  const res = await post([cpEvt('c1'), moodEvt('m1')]);
  assert.equal(res.body.accepted, 1, 'the mood entry');
  assert.equal(res.body.dropped, 0, 'the conflict pulse was stored, not lost');
  assert.equal(res.body.conflictPulses.stored, 1);
});

test('stored row columns come from the token + payload', async () => {
  await post([cpEvt('c1', { topic: 'cleanliness', level: 2, raised: true, at: 777 })]);
  const p = cpInserts[0]; // [id, user_id, match_id, topic, level, raised, at]
  assert.equal(p[0], 'c1');
  assert.equal(p[1], 'user-A', 'user_id from the token, not the client');
  assert.equal(p[2], 'user-B');
  assert.equal(p[3], 'cleanliness');
  assert.equal(p[4], 2);
  assert.equal(p[5], true);
  assert.equal(p[6], 777);
});

test('a conflict_pulses failure NEVER fails the student batch', async () => {
  cpInsertThrows = true;
  const res = await post([moodEvt('m1'), cpEvt('c1')]);
  assert.equal(res.status, 200, 'the batch still succeeds');
  assert.equal(telemetryInserts.length, 1, 'ordinary telemetry still landed');
  assert.deepEqual(res.body.conflictPulses, { stored: 0, dropped: 0 });
});

test('malformed conflict_pulse (bad level / self / missing topic) dropped + reported', async () => {
  for (const bad of [
    cpEvt('b1', { level: 9 }),
    cpEvt('b2', { matchId: 'user-A' }),   // read about self
    cpEvt('b3', { topic: '' }),
    cpEvt('b4', { at: 'nope' }),
  ]) {
    cpInserts = [];
    const res = await post([bad]);
    assert.equal(cpInserts.length, 0, `should drop ${bad.id}`);
    assert.deepEqual(res.body.conflictPulses, { stored: 0, dropped: 1 });
  }
});

// ── join route ──────────────────────────────────────────────────────────────
test('GET /conflict-pulse/:matchId returns the counterpart reads', async () => {
  cpSelectRows = [
    { topic: 'guests', level: 1, raised: false, at: '100' },   // BIGINT → string from pg
    { topic: 'guests', level: 2, raised: true, at: '200' },
  ];
  const res = await request(app).get('/conflict-pulse/user-B');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.reads.length, 2);
  assert.deepEqual(res.body.reads[0], { topic: 'guests', level: 1, raised: false, at: 100 });
  assert.strictEqual(typeof res.body.reads[1].at, 'number', 'BIGINT string cast back to number');
});

test('GET /conflict-pulse/:matchId rejects a read about yourself (400)', async () => {
  const res = await request(app).get('/conflict-pulse/user-A'); // == req.user.id
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
});
