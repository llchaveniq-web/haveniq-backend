// POST /me/match-outcomes — pins which outcomes stamp a pairing_outcomes
// funnel event (services/pairingOutcomes.js), the labels
// services/dimensionModel.js's Loop B trainer needs. Before this wiring,
// 'connect'/'message'/'match'/'decline' were the only funnel steps ever
// recorded — nothing ever stamped moved_in_at/room_change_at/ghosted_at, so
// labelOutcome() could never produce a training label and the trainer ran
// daily against zero examples regardless of real outcome volume.
// lost_contact -> 'ghost' is the app's first honest ghosting signal: a direct
// report (the meet48 "no" follow-up), not inferred from message-silence.
// pool/auth/sentry stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let outcomeInserts = [];
let pairingInserts = [];
inject('../db/pool', {
  query: async (sql, params) => {
    if (/INSERT INTO match_outcomes/.test(sql)) { outcomeInserts.push(params); return { rows: [] }; }
    if (/INSERT INTO pairing_outcomes/.test(sql)) { pairingInserts.push({ sql, params }); return { rows: [] }; }
    return { rows: [] };
  },
});
inject('../middleware/auth', { requireAuth: (req, _res, next) => { req.user = { id: 'user-a' }; next(); } });
inject('../utils/sentry', { captureError: () => {} });
delete process.env.DISCORD_WEBHOOK_URL;

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/', require('./matchOutcomes'));

const post = (outcome) =>
  request(app).post('/me/match-outcomes').send({ otherUserId: 'user-b', outcome });

test.beforeEach(() => { outcomeInserts = []; pairingInserts = []; });

// Give the fire-and-forget recordPairingEvent() a tick to run before asserting.
const tick = () => new Promise((r) => setImmediate(r));

const CASES = [
  ['moved_in_together', 'moved_in_at'],
  ['met_in_person', 'met_at'],
  ['ended_roommate_relationship', 'room_change_at'],
  ['lost_contact', 'ghosted_at'],
];

for (const [outcome, column] of CASES) {
  test(`${outcome} stamps pairing_outcomes.${column}`, async () => {
    const res = await post(outcome);
    assert.equal(res.status, 200);
    await tick();
    assert.equal(pairingInserts.length, 1, `expected exactly one pairing_outcomes write for ${outcome}`);
    assert.match(pairingInserts[0].sql, new RegExp(column));
    const [a, b] = pairingInserts[0].params;
    assert.deepEqual([a, b].sort(), ['user-a', 'user-b'].sort());
  });
}

// The deliberate non-mapping: this outcome never reached moved_in_together,
// so forcing it into 'room_change' would mislabel "never tried" as "tried
// and it broke down" — it must stay censored (unlabeled), not miscoded.
for (const outcome of ['decided_not_to_continue', 'survey_60d', 'still_chatting']) {
  test(`${outcome} does NOT stamp any pairing_outcomes funnel event`, async () => {
    const res = await post(outcome);
    assert.equal(res.status, 200);
    await tick();
    assert.equal(pairingInserts.length, 0, `${outcome} has no unambiguous funnel mapping and must stay uncoded`);
  });
}

test('the match_outcomes row is still written regardless of the pairing_outcomes mapping', async () => {
  await post('moved_in_together');
  await tick();
  assert.equal(outcomeInserts.length, 1);
  assert.equal(outcomeInserts[0][2], 'moved_in_together');
});
