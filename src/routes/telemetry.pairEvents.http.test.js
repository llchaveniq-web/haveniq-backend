// POST /telemetry/batch — the pair_event side-channel. Pins that the research
// stream is routed to its own table, that it can never take a student's
// telemetry batch down with it, and that the response counters tell the truth
// about what was stored. DB/auth stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let telemetryInserts = [];
let pairInserts = [];
let pairInsertThrows = false;

inject('../db/pool', {
  connect: async () => ({
    query: async (sql, params) => {
      if (/INSERT INTO telemetry_events/.test(sql)) telemetryInserts.push(params);
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  }),
  query: async (sql, params) => {
    if (/INSERT INTO pair_events/.test(sql)) {
      if (pairInsertThrows) throw new Error('pair table exploded');
      pairInserts.push(params);
      return { rows: [], rowCount: 1 };
    }
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

const pairEvt = (id, t, kind, subtype) => ({
  id, type: 'pair_event', category: 'longitudinal', timestamp: t,
  payload: { pairId: 'user-B', t, kind, subtype, topic: 'guests' },
});
const moodEvt = (id) => ({
  id, type: 'mood_entry', category: 'wellbeing', timestamp: 1, payload: { mood: 3 },
});

const post = (events) =>
  request(app).post('/telemetry/batch').send({ deviceId: 'dev-1', events });

test.beforeEach(() => {
  telemetryInserts = []; pairInserts = []; pairInsertThrows = false;
  require('../services/pairEvents')._resetTableReady();
});

test('a pair_event is routed to pair_events, NOT telemetry_events', async () => {
  const res = await post([pairEvt('p1', 100, 'signal', 'pulse')]);
  assert.equal(res.status, 200);
  assert.equal(pairInserts.length, 1);
  assert.equal(telemetryInserts.length, 0, 'it must not double-write into the generic blob');
  assert.deepEqual(res.body.pairEvents, { stored: 1, dropped: 0 });
});

test('pair_events are not counted as dropped (they were stored)', async () => {
  const res = await post([pairEvt('p1', 100, 'signal', 'pulse'), moodEvt('m1')]);
  assert.equal(res.body.accepted, 1, 'the mood entry');
  assert.equal(res.body.dropped, 0, 'the pair event was stored, not lost');
  assert.equal(res.body.pairEvents.stored, 1);
});

test('the two streams coexist in one batch', async () => {
  await post([moodEvt('m1'), pairEvt('p1', 100, 'signal', 'pulse'), moodEvt('m2')]);
  assert.equal(telemetryInserts.length, 2);
  assert.equal(pairInserts.length, 1);
});

test('a pair_events failure NEVER fails the student\'s telemetry batch', async () => {
  pairInsertThrows = true;
  const res = await post([moodEvt('m1'), pairEvt('p1', 100, 'signal', 'pulse')]);
  assert.equal(res.status, 200, 'the batch still succeeds');
  assert.equal(telemetryInserts.length, 1, 'ordinary telemetry still landed');
  assert.deepEqual(res.body.pairEvents, { stored: 0, dropped: 0 });
});

test('user_id on the stored row comes from the token', async () => {
  await post([pairEvt('p1', 100, 'signal', 'pulse')]);
  assert.equal(pairInserts[0][1], 'user-A');
  assert.equal(pairInserts[0][2], 'user-B');
  assert.equal(pairInserts[0][3], ['user-A', 'user-B'].sort().join(':'));
});

test('a malformed pair_event is dropped and reported, not stored', async () => {
  const bad = pairEvt('p2', 100, 'nonsense_kind', 'pulse');
  const res = await post([bad]);
  assert.equal(pairInserts.length, 0);
  assert.deepEqual(res.body.pairEvents, { stored: 0, dropped: 1 });
});

test('a batch with no pair_events reports zeroes', async () => {
  const res = await post([moodEvt('m1')]);
  assert.deepEqual(res.body.pairEvents, { stored: 0, dropped: 0 });
});
