// POST /roommate-safety-reports — the high-severity single-report alert fix.
//
// The ONLY alert in this file used to be maybeAlertPattern, which requires
// a SECOND distinct reporter before anything fires — so a lone, first-ever
// report of "Physical aggression" or "Threats or intimidation" produced no
// Discord post, no audit row, and no analytics event: identical to a lone
// report of "won't respect my space or boundaries." This locks: a
// high-severity category alerts on the FIRST report; low-severity
// categories still don't (unless a pattern forms, covered by the sibling
// patternAlert test file); and every report — high or low severity — now
// writes an audit row and fires an analytics event, matching the generic
// matches.js report flow this route was missing parity with.
// pool/auth/fetch stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let countResult = { distinct_reporters: 1, my_reports: 1 }; // first-ever report by default
inject('../db/pool', {
  query: async (sql) => {
    if (/INSERT INTO roommate_safety_reports/.test(sql)) return { rows: [{ id: 'report-1' }] };
    if (/COUNT\(DISTINCT reporter_id\)/.test(sql)) return { rows: [countResult] };
    if (/SELECT first_name FROM users/.test(sql)) return { rows: [{ first_name: 'Pat' }] };
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'reporter-1', email: 'a@ohio.edu', first_name: 'Reporter' }; next(); },
  refuseBanned: (_q, _s, n) => n(),
});

let auditCalls = [];
inject('../services/auditLog', {
  audit: async (req, action, details) => { auditCalls.push({ userId: req.user?.id, action, details }); },
});
let analyticsCalls = [];
inject('../services/analytics', {
  track: (event, userId, props) => { analyticsCalls.push({ event, userId, props }); },
  EVENTS: { report_submitted: 'report_submitted' },
});

process.env.DISCORD_WEBHOOK_URL = 'https://discord.test/hook';
let fetchCalls = [];
global.fetch = async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true, status: 204 }; };

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/roommate-safety-reports', require('./roommateSafety'));

const fileReport = (category) =>
  request(app).post('/roommate-safety-reports')
    .send({ reportedId: 'reported-9', category, detail: 'x' });

const settle = () => new Promise((r) => setTimeout(r, 25));

test.beforeEach(() => {
  fetchCalls = [];
  auditCalls = [];
  analyticsCalls = [];
  countResult = { distinct_reporters: 1, my_reports: 1 };
});

test('a LONE first-ever "Physical aggression" report alerts immediately — this was the gap', async () => {
  const res = await fileReport('Physical aggression');
  assert.equal(res.status, 200);
  await settle();
  assert.equal(fetchCalls.length, 1, 'a single high-severity report must page, not wait for a 2nd reporter');
  const embed = JSON.parse(fetchCalls[0].opts.body).embeds[0];
  assert.match(embed.title, /HIGH SEVERITY/);
  assert.match(embed.description, /Physical aggression/);
  assert.match(embed.description, /Pat/, 'names the reported student');
});

test('a LONE first-ever "Threats or intimidation" report also alerts immediately', async () => {
  const res = await fileReport('Threats or intimidation');
  assert.equal(res.status, 200);
  await settle();
  assert.equal(fetchCalls.length, 1);
  assert.match(JSON.parse(fetchCalls[0].opts.body).embeds[0].description, /Threats or intimidation/);
});

test('a LONE first-ever low-severity report does NOT alert (unchanged behavior)', async () => {
  const res = await fileReport('Other safety concern');
  assert.equal(res.status, 200);
  await settle();
  assert.equal(fetchCalls.length, 0, 'no severity match and no pattern yet → no alert');
});

test('a LONE first-ever "boundaries" report does NOT alert either', async () => {
  await fileReport("Won't respect my space or boundaries");
  await settle();
  assert.equal(fetchCalls.length, 0);
});

test('every report — high or low severity — is now audit-logged and analytics-tracked', async () => {
  await fileReport('Other safety concern');
  await settle();
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].userId, 'reporter-1');
  assert.equal(auditCalls[0].action, 'roommate_safety_report.file');
  assert.equal(auditCalls[0].details.reported, 'reported-9');
  assert.equal(auditCalls[0].details.category, 'Other safety concern');

  assert.equal(analyticsCalls.length, 1);
  assert.equal(analyticsCalls[0].event, 'report_submitted');
  assert.equal(analyticsCalls[0].userId, 'reporter-1');
  assert.equal(analyticsCalls[0].props.target_user_id, 'reported-9');
  assert.equal(analyticsCalls[0].props.reason, 'Other safety concern');
});

test('a high-severity report that ALSO happens to be the 2nd distinct reporter fires BOTH alerts', async () => {
  countResult = { distinct_reporters: 2, my_reports: 1 };
  await fileReport('Physical aggression');
  await settle();
  assert.equal(fetchCalls.length, 2, 'the severity alert and the pattern alert are independent signals');
  const titles = fetchCalls.map((c) => JSON.parse(c.opts.body).embeds[0].title);
  assert.ok(titles.some((t) => /HIGH SEVERITY/.test(t)));
  assert.ok(titles.some((t) => /pattern/i.test(t)));
});
