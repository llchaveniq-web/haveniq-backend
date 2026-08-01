// POST /roommate-safety-reports real-time pattern alert. Pins that a forming
// pattern (a NEW distinct reporter against an already-reported person) fires a
// Discord alert immediately, and that it never fires on a first-ever report or
// re-fires for the same reporter+person. pool/auth/fetch stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// Programmable result for the DISTINCT-reporter count query.
let countResult = { distinct_reporters: 1, my_reports: 1 };
inject('../db/pool', {
  query: async (sql) => {
    if (/INSERT INTO roommate_safety_reports/.test(sql)) return { rows: [{ id: 'report-1' }] };
    if (/COUNT\(DISTINCT reporter_id\)/.test(sql)) return { rows: [countResult] };
    if (/SELECT first_name FROM users/.test(sql)) return { rows: [{ first_name: 'Pat' }] };
    return { rows: [] }; // CREATE TABLE/INDEX etc.
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'reporter-1', email: 'a@ohio.edu' }; next(); },
  refuseBanned: (_q, _s, n) => n(),
});

process.env.DISCORD_WEBHOOK_URL = 'https://discord.test/hook';

// Capture Discord posts.
let fetchCalls = [];
global.fetch = async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true, status: 204 }; };

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/roommate-safety-reports', require('./roommateSafety'));

const fileReport = () =>
  request(app).post('/roommate-safety-reports')
    .send({ reportedId: 'reported-9', category: 'Other safety concern', detail: 'x' });

// maybeAlertPattern is fire-and-forget (runs AFTER res.json); give the detached
// chain a tick to finish before asserting.
const settle = () => new Promise((r) => setTimeout(r, 25));

test.beforeEach(() => { fetchCalls = []; });

test('NO alert on a person\'s first-ever report (only reporter)', async () => {
  countResult = { distinct_reporters: 1, my_reports: 1 };
  const res = await fileReport();
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  await settle();
  assert.equal(fetchCalls.length, 0, 'no pattern yet → no Discord alert');
});

test('ALERT when a NEW distinct reporter hits an already-reported person', async () => {
  countResult = { distinct_reporters: 2, my_reports: 1 };
  const res = await fileReport();
  assert.equal(res.status, 200);
  await settle();
  assert.equal(fetchCalls.length, 1, 'forming pattern → one Discord alert');
  const body = JSON.parse(fetchCalls[0].opts.body);
  const embed = body.embeds[0];
  assert.match(embed.title, /pattern/i);
  assert.match(embed.description, /Pat/, 'names the reported student');
  assert.match(embed.description, /\*\*2\*\* different students/i, 'includes the distinct-reporter count');
  const drField = embed.fields.find(f => /distinct reporters/i.test(f.name));
  assert.equal(drField && drField.value, '2', 'distinct-reporter count in a field');
});

test('NO re-fire when the SAME reporter flags the same person again', async () => {
  countResult = { distinct_reporters: 2, my_reports: 2 }; // this reporter's 2nd report
  await fileReport();
  await settle();
  assert.equal(fetchCalls.length, 0, 'same reporter+person twice → no repeat alert');
});

test('no webhook configured → no-op (never throws)', async () => {
  const saved = process.env.DISCORD_WEBHOOK_URL;
  delete process.env.DISCORD_WEBHOOK_URL;
  countResult = { distinct_reporters: 3, my_reports: 1 }; // would otherwise fire
  const res = await fileReport();
  assert.equal(res.status, 200, 'report still succeeds with no webhook');
  await settle();
  assert.equal(fetchCalls.length, 0);
  process.env.DISCORD_WEBHOOK_URL = saved;
});
