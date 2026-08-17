// POST /pulses — the content-moderation fix.
//
// match_pulses.note previously went straight to the DB with ZERO cleaning:
// no PII redaction, no length cap, no content screening, and — unlike the
// nearly identical note field in matchOutcomes.js's check-ins — no
// crisis/threat safety paging. This is a real gap because the note is
// mutually visible to BOTH matched roommates (GET /pulses/match/:requestId
// deliberately shows each side the other's notes), so an unscreened note
// could deliver a slur/threat straight to a roommate, and a self-harm
// signal in a pulse note previously paged no one.
//
// sanitizeNoteText/maybePageSafety are the EXACT same shared functions
// matchOutcomes.js now uses (lib/textSanitize.js, services/checkinSafety.js)
// — this locks that pulses.js is actually wired to them, not a parallel
// copy that could drift. pool/auth/contentFilter stubbed (real
// screenMessage/crisisAlert logic runs, not a stubbed verdict). node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let ownRow = { id: 'cr-1' };
let inserts = [];
inject('../db/pool', {
  query: async (sql, params) => {
    if (/SELECT id FROM connect_requests/.test(sql)) {
      return { rows: ownRow ? [ownRow] : [] };
    }
    if (/INSERT INTO match_pulses/.test(sql)) {
      inserts.push(params);
      return { rows: [] };
    }
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'u1' }; next(); },
});
inject('../services/analytics', { track: () => {}, EVENTS: { pulse_submitted: 'pulse_submitted' } });

let alertCalls = [];
const origFetch = global.fetch;
global.fetch = async (url, opts) => { alertCalls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 204 }; };
process.env.DISCORD_WEBHOOK_URL = 'https://discord.test/hook';

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/pulses', require('./pulses'));

const post = (body) => request(app).post('/pulses').send({ requestId: 'cr-1', dayMarker: 60, status: 'having_issues', ...body });
const settle = () => new Promise((r) => setImmediate(r));

test.beforeEach(() => { ownRow = { id: 'cr-1' }; inserts = []; alertCalls = []; });
test.after(() => { global.fetch = origFetch; });

test('a normal note is stored as-is (trimmed)', async () => {
  const res = await post({ note: '  things have been fine, just noisy at night  ' });
  assert.equal(res.status, 200);
  assert.equal(inserts[0][4], 'things have been fine, just noisy at night');
});

test('a note with an email/phone/handle is redacted before storage', async () => {
  await post({ note: 'text me at 555-867-5309 or email me at a@b.com or hit @myhandle' });
  const stored = inserts[0][4];
  assert.ok(!stored.includes('555-867-5309'));
  assert.ok(!stored.includes('a@b.com'));
  assert.ok(!stored.includes('@myhandle'));
  assert.match(stored, /\[redacted\]/);
});

test('a slur/threat note is replaced with a placeholder, not stored raw — the submission itself still succeeds', async () => {
  const res = await post({ note: 'i will find you and hurt you if this continues' });
  assert.equal(res.status, 200, 'the structured status/outcome is the point — a bad note must not fail the whole pulse');
  assert.equal(inserts[0][4], '[removed by safety filter]');
});

test('no note at all stores null, no crash', async () => {
  const res = await post({});
  assert.equal(res.status, 200);
  assert.equal(inserts[0][4], null);
});

test('a crisis (self-harm) note pages the safety team — this is the gap that was missing entirely', async () => {
  const res = await post({ note: "I've honestly been thinking about ending my life over this" });
  assert.equal(res.status, 200);
  await settle();
  assert.equal(alertCalls.length, 1);
  assert.match(alertCalls[0].body.embeds[0].title, /CRISIS/);
  assert.equal(alertCalls[0].body.embeds[0].fields.find(f => f.name === 'Source').value, '`pulse`');
});

test('a threat note pages the safety team too', async () => {
  await post({ note: 'i will kill you if you keep leaving dishes out' });
  await settle();
  assert.equal(alertCalls.length, 1);
  assert.match(alertCalls[0].body.embeds[0].title, /THREAT/);
});

test('the paged excerpt is the ALREADY-redacted note, never the raw one', async () => {
  await post({ note: 'call me at 555-123-4567, also i will hurt you if you tell anyone' });
  await settle();
  const excerpt = alertCalls[0].body.embeds[0].fields.find(f => f.name.startsWith('Note')).value;
  assert.ok(!excerpt.includes('555-123-4567'), 'PII must be redacted even in the safety-team alert');
});

test('a benign note does NOT page', async () => {
  await post({ note: 'noise has been a little much but we talked it out and it is fine now' });
  await settle();
  assert.equal(alertCalls.length, 0);
});

test('a non-member of the request cannot submit a pulse about it', async () => {
  ownRow = null;
  const res = await post({ note: 'anything' });
  assert.equal(res.status, 403);
  assert.equal(inserts.length, 0);
});

test('an invalid dayMarker or status is still rejected before moderation runs', async () => {
  assert.equal((await post({ dayMarker: 45 })).status, 400);
  assert.equal((await post({ status: 'bogus' })).status, 400);
});
