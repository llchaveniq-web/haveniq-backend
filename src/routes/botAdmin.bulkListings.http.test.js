// POST /bot-admin/listings/bulk and GET /bot-admin/review.
//
// The collector files ~500 listings a day as 'pending' and nothing reaches a
// student until a human approves it. Reviewing one listing per HTTP request
// turned that gate into a bottleneck that kept the housing tab empty, so these
// two endpoints exist to make the pass fast WITHOUT removing the human.
//
// What is tested hardest is the part that could quietly break the promise on
// the landing page: that bulk approval only ever moves a row OUT of pending,
// that it cannot be aimed at the whole queue in one call, and that the review
// page — which is served unauthenticated because a browser cannot set an
// Authorization header on a navigation — leaks no listing data.
// node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

process.env.ADMIN_BOT_TOKEN = 'test-bot-token';

let listings = new Map();
let auditRows = [];

inject('../db/pool', {
  query: async (sql, params = []) => {
    if (/CREATE (TABLE|INDEX)/i.test(sql)) return { rows: [] };
    if (/INSERT INTO bot_admin_audit/i.test(sql)) { auditRows.push(params); return { rows: [] }; }

    if (/UPDATE listings[\s\S]*'approved'/i.test(sql)) {
      const ids = params[0];
      const hit = ids.filter(id => listings.get(id)?.moderation_status === 'pending');
      hit.forEach(id => { listings.get(id).moderation_status = 'approved'; });
      return { rows: hit.map(id => ({ id })) };
    }
    if (/UPDATE listings[\s\S]*'rejected'/i.test(sql)) {
      const ids = params[0];
      const hit = ids.filter(id => listings.get(id) && listings.get(id).moderation_status !== 'rejected');
      hit.forEach(id => { listings.get(id).moderation_status = 'rejected'; });
      return { rows: hit.map(id => ({ id })) };
    }
    return { rows: [] };
  },
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/bot-admin', require('./botAdmin'));

const AUTH = { Authorization: 'Bearer test-bot-token' };

test.beforeEach(() => {
  auditRows = [];
  listings = new Map([
    [1, { id: 1, moderation_status: 'pending' }],
    [2, { id: 2, moderation_status: 'pending' }],
    [3, { id: 3, moderation_status: 'approved' }],   // already cleared by a human
    [4, { id: 4, moderation_status: 'rejected' }],
  ]);
});

test('bulk approve flips the pending rows and reports how many it acted on', async () => {
  const res = await request(app).post('/bot-admin/listings/bulk')
    .set(AUTH).send({ action: 'approve', ids: [1, 2] });
  assert.equal(res.status, 200);
  assert.equal(res.body.acted, 2);
  assert.equal(listings.get(1).moderation_status, 'approved');
  assert.equal(listings.get(2).moderation_status, 'approved');
});

test('an already-rejected listing is not resurrected by a bulk approve', async () => {
  // The reason the single-listing route guards on status too: a second
  // reviewer's rejection must not be undone by a stale page approving in bulk.
  const res = await request(app).post('/bot-admin/listings/bulk')
    .set(AUTH).send({ action: 'approve', ids: [1, 4] });
  assert.equal(res.body.acted, 1);
  assert.deepEqual(res.body.ids, [1]);
  assert.equal(listings.get(4).moderation_status, 'rejected');
});

test('bulk approve is idempotent, so a double-submit is a no-op', async () => {
  await request(app).post('/bot-admin/listings/bulk').set(AUTH).send({ action: 'approve', ids: [1] });
  const again = await request(app).post('/bot-admin/listings/bulk').set(AUTH).send({ action: 'approve', ids: [1] });
  assert.equal(again.body.acted, 0);
});

test('bulk reject deactivates and is reversible from the audit row', async () => {
  const res = await request(app).post('/bot-admin/listings/bulk')
    .set(AUTH).send({ action: 'reject', ids: [1, 2], reason: 'duplicate building' });
  assert.equal(res.body.acted, 2);
  const payload = JSON.parse(auditRows.at(-1)[3]);
  assert.deepEqual(payload.requested, [1, 2]);
  assert.deepEqual(payload.acted, [1, 2]);
  assert.equal(payload.reason, 'duplicate building');
});

test('the audit row records requested vs acted, not just a count', async () => {
  await request(app).post('/bot-admin/listings/bulk').set(AUTH).send({ action: 'approve', ids: [1, 3] });
  const [botName, action, , , result] = auditRows.at(-1);
  assert.equal(botName, 'listing-review');
  assert.equal(action, 'bulk-approve');
  assert.equal(result, '1/2');
});

test('an unknown action is refused rather than defaulting to approve', async () => {
  for (const action of ['publish', 'APPROVE', '', undefined]) {
    const res = await request(app).post('/bot-admin/listings/bulk').set(AUTH).send({ action, ids: [1] });
    assert.equal(res.status, 400, String(action));
  }
  assert.equal(listings.get(1).moderation_status, 'pending');
});

test('an empty or non-numeric id list is refused', async () => {
  for (const ids of [[], undefined, 'all', ['x', null]]) {
    const res = await request(app).post('/bot-admin/listings/bulk').set(AUTH).send({ action: 'approve', ids });
    assert.equal(res.status, 400, JSON.stringify(ids));
  }
});

test('a single call cannot sweep the entire queue', async () => {
  // The cap is what stops a malformed client — or a stray script — from
  // publishing every pending listing in one request.
  const res = await request(app).post('/bot-admin/listings/bulk')
    .set(AUTH).send({ action: 'approve', ids: Array.from({ length: 201 }, (_, i) => i + 1) });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /200/);
});

test('bulk review requires the admin token', async () => {
  const res = await request(app).post('/bot-admin/listings/bulk').send({ action: 'approve', ids: [1] });
  assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  assert.equal(listings.get(1).moderation_status, 'pending');
});

test('the review page is served without a token but carries no listing data', async () => {
  // It is markup and script only; every byte of data behind it comes from the
  // token-gated JSON endpoints the page calls after the reviewer pastes the
  // token. If this ever starts embedding rows, it becomes a public leak.
  const res = await request(app).get('/bot-admin/review');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.text, /listing review/i);
  assert.doesNotMatch(res.text, /moderation_status\s*[:=]\s*['"]pending/);
  assert.doesNotMatch(res.text, /test-bot-token/);
});

test('the review page asks robots to stay away', async () => {
  const res = await request(app).get('/bot-admin/review');
  assert.match(res.headers['x-robots-tag'] || '', /noindex/);
  assert.match(res.headers['cache-control'] || '', /no-store/);
});
