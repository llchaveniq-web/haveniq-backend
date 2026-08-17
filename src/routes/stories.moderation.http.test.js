// POST /stories — the content-moderation fix.
//
// Stories was the one public, persistent, cross-user feed in the app with
// NO content screening at all — every other UGC surface (messages,
// reviews, vouches, agreements, match-outcome notes) runs through
// screenMessage. The `hidden` column existed in the schema and was
// filtered on read, but nothing ever set it — there was no admin review
// path either. This locks: BLOCK-tier content is refused outright,
// FLAG-tier content still posts but is queued (flagged_category/at set,
// surfaced via GET /admin), crisis language pages the safety team (even
// when the post is also blocked), and the moderator-only admin routes
// actually work. pool/auth/contentFilter/crisisAlert stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let inserts = [];
let updateCalls = [];
let adminRows = [];
inject('../db/pool', {
  query: async (sql, params) => {
    if (/ALTER TABLE/.test(sql)) return { rows: [] };
    if (/INSERT INTO stories/.test(sql)) {
      inserts.push(params);
      return { rows: [{ id: 'story-1', created_at: '2026-08-16T00:00:00Z' }] };
    }
    if (/UPDATE stories SET hidden/.test(sql)) {
      updateCalls.push(params);
      return { rowCount: params[1] === 'missing' ? 0 : 1 };
    }
    if (/FROM stories s/.test(sql) && /flagged_category/.test(sql)) return { rows: adminRows };
    return { rows: [] };
  },
});

// Real screening logic, not a stub — this test is specifically about the
// moderation wiring, so it should exercise the real BLOCK/FLAG/crisis rules.
const { screenMessage, CRISIS_SUPPORT } = require('../lib/contentFilter');
inject('../lib/contentFilter', { screenMessage, CRISIS_SUPPORT });

let crisisAlertCalls = [];
inject('../services/crisisAlert', {
  maybeAlertCrisis: async (user, ref) => { crisisAlertCalls.push({ userId: user.id, ref }); return { alerted: true }; },
});

let currentUser = { id: 'u1', school: 'Ohio University' };
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = currentUser; next(); },
});
inject('../utils/founders', {
  isModeratorUser: (u) => u?.id === 'mod-1',
});
inject('../services/auditLog', { audit: async () => {} });

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/stories', require('./stories'));

const asUser = (id) => { currentUser = { id, school: 'Ohio University' }; };
test.beforeEach(() => { inserts = []; updateCalls = []; adminRows = []; crisisAlertCalls = []; asUser('u1'); });

test('a normal story posts fine, no flag', async () => {
  const res = await request(app).post('/stories').send({ title: 'Found a great place', body: 'Sublet went smoothly, landlord was responsive the whole time.' });
  assert.equal(res.status, 200);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][6], null, 'flagged_category is null');
});

test('a slur/threat is refused outright (BLOCK), never inserted', async () => {
  const res = await request(app).post('/stories')
    .send({ title: 'my roommate', body: 'i will kill you if you touch my stuff again' });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, 'content_blocked');
  assert.equal(inserts.length, 0);
});

test('a scam-signal post (FLAG) still posts, but is queued for review', async () => {
  const res = await request(app).post('/stories')
    .send({ title: 'heads up', body: 'landlord asked for a deposit in bitcoin before we could tour' });
  assert.equal(res.status, 200);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][6], 'scam', 'flagged_category set');
  assert.ok(inserts[0][7], 'flagged_at set');
});

test('crisis language in a post that is NOT otherwise blocked still pages the safety team, and returns support resources', async () => {
  const res = await request(app).post('/stories')
    .send({ title: 'rough week', body: "honestly I've been thinking about ending my life and I don't know what to do" });
  assert.equal(res.status, 200);
  assert.equal(res.body.support?.lifeline, '988');
  assert.equal(crisisAlertCalls.length, 1);
  assert.equal(crisisAlertCalls[0].userId, 'u1');
});

test('crisis language in a post that IS also blocked still pages the safety team, even though the post is refused', async () => {
  const res = await request(app).post('/stories')
    .send({ title: 'x', body: 'i will kill you and also i want to kill myself' });
  assert.equal(res.status, 422);
  assert.equal(crisisAlertCalls.length, 1, 'a rejected post must not also drop the person most at risk');
});

test('title too long / body too long / missing fields still validate before moderation runs', async () => {
  assert.equal((await request(app).post('/stories').send({ title: '', body: 'x' })).status, 400);
  assert.equal((await request(app).post('/stories').send({ title: 'x', body: '' })).status, 400);
});

// ── Admin review surface ──
test('a non-moderator cannot read the admin list', async () => {
  asUser('random-student');
  const res = await request(app).get('/stories/admin');
  assert.equal(res.status, 403);
});

test('a moderator gets the flagged queue by default', async () => {
  asUser('mod-1');
  adminRows = [{ id: 's1', title: 'x', flagged_category: 'scam' }];
  const res = await request(app).get('/stories/admin');
  assert.equal(res.status, 200);
  assert.equal(res.body.stories.length, 1);
});

test('a non-moderator cannot hide a story', async () => {
  asUser('random-student');
  const res = await request(app).patch('/stories/story-1').send({ hidden: true });
  assert.equal(res.status, 403);
});

test('a moderator can hide a story — this is what the hidden column was always meant to support', async () => {
  asUser('mod-1');
  const res = await request(app).patch('/stories/story-1').send({ hidden: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.hidden, true);
  assert.deepEqual(updateCalls[0], [true, 'story-1']);
});

test('hiding a story that does not exist 404s, never a silent success', async () => {
  asUser('mod-1');
  const res = await request(app).patch('/stories/missing').send({ hidden: true });
  assert.equal(res.status, 404);
});

test('a non-boolean hidden value is rejected', async () => {
  asUser('mod-1');
  const res = await request(app).patch('/stories/story-1').send({ hidden: 'yes' });
  assert.equal(res.status, 400);
});
