// POST /bot-admin/listings/bulk and GET /bot-admin/review.
//
// The collector files ~500 listings a day as 'pending' and nothing reaches a
// student until a human approves it. Reviewing one listing per HTTP request
// turned that gate into a bottleneck that kept the housing tab empty, so these
// two endpoints exist to make the pass fast WITHOUT removing the human.
//
// The fixture uses real UUIDs because listings.id IS a uuid. An earlier
// version of this file stubbed integer ids, which let the route ship
// validating "positive integer" and casting to ::int[] — it could never have
// worked against the real table, and these tests could never have noticed. A
// stub that invents the schema tests the assumption, not the code.
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

// Real v4 shapes — the route validates the format, so '1' would be rejected.
const ID1 = 'be85abce-9a6f-4af0-8e08-d6c51c987a90';
const ID2 = 'c75f9d5a-13f5-4f8d-ac76-cf6b43da674c';
const ID3 = '11111111-2222-4333-8444-555555555555';
const ID4 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const uuidN = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let sqls = [];

inject('../db/pool', {
  query: async (sql, params = []) => {
    sqls.push(sql);
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
  sqls = [];
  listings = new Map(Object.entries({
    [ID1]: { id: ID1, moderation_status: 'pending' },
    [ID2]: { id: ID2, moderation_status: 'pending' },
    [ID3]: { id: ID3, moderation_status: 'approved' },   // already cleared by a human
    [ID4]: { id: ID4, moderation_status: 'rejected' },
  }));
});

test('bulk approve flips the pending rows and reports how many it acted on', async () => {
  const res = await request(app).post('/bot-admin/listings/bulk')
    .set(AUTH).send({ action: 'approve', ids: [ID1, ID2] });
  assert.equal(res.status, 200);
  assert.equal(res.body.acted, 2);
  assert.equal(listings.get(ID1).moderation_status, 'approved');
  assert.equal(listings.get(ID2).moderation_status, 'approved');
});

test('an already-rejected listing is not resurrected by a bulk approve', async () => {
  // The reason the single-listing route guards on status too: a second
  // reviewer's rejection must not be undone by a stale page approving in bulk.
  const res = await request(app).post('/bot-admin/listings/bulk')
    .set(AUTH).send({ action: 'approve', ids: [ID1, ID4] });
  assert.equal(res.body.acted, 1);
  assert.deepEqual(res.body.ids, [ID1]);
  assert.equal(listings.get(ID4).moderation_status, 'rejected');
});

test('bulk approve is idempotent, so a double-submit is a no-op', async () => {
  await request(app).post('/bot-admin/listings/bulk').set(AUTH).send({ action: 'approve', ids: [ID1] });
  const again = await request(app).post('/bot-admin/listings/bulk').set(AUTH).send({ action: 'approve', ids: [ID1] });
  assert.equal(again.body.acted, 0);
});

test('bulk reject deactivates and is reversible from the audit row', async () => {
  const res = await request(app).post('/bot-admin/listings/bulk')
    .set(AUTH).send({ action: 'reject', ids: [ID1, ID2], reason: 'duplicate building' });
  assert.equal(res.body.acted, 2);
  const payload = JSON.parse(auditRows.at(-1)[3]);
  assert.deepEqual(payload.requested, [ID1, ID2]);
  assert.deepEqual(payload.acted, [ID1, ID2]);
  assert.equal(payload.reason, 'duplicate building');
});

test('the audit row records requested vs acted, not just a count', async () => {
  await request(app).post('/bot-admin/listings/bulk').set(AUTH).send({ action: 'approve', ids: [ID1, ID3] });
  const [botName, action, , , result] = auditRows.at(-1);
  assert.equal(botName, 'listing-review');
  assert.equal(action, 'bulk-approve');
  assert.equal(result, '1/2');
});

test('an unknown action is refused rather than defaulting to approve', async () => {
  for (const action of ['publish', 'APPROVE', '', undefined]) {
    const res = await request(app).post('/bot-admin/listings/bulk').set(AUTH).send({ action, ids: [ID1] });
    assert.equal(res.status, 400, String(action));
  }
  assert.equal(listings.get(ID1).moderation_status, 'pending');
});

test('an empty or non-numeric id list is refused', async () => {
  for (const ids of [[], undefined, 'all', ['x', null], [1, 2], ['00000000-0000-4000-8000-00000000000'], [ID1, 7]]) {
    const res = await request(app).post('/bot-admin/listings/bulk').set(AUTH).send({ action: 'approve', ids });
    assert.equal(res.status, 400, JSON.stringify(ids));
  }
});

test('a single call cannot sweep the entire queue', async () => {
  // The cap is what stops a malformed client — or a stray script — from
  // publishing every pending listing in one request.
  const res = await request(app).post('/bot-admin/listings/bulk')
    .set(AUTH).send({ action: 'approve', ids: Array.from({ length: 201 }, (_, i) => uuidN(i + 1)) });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /200/);
});

test('bulk review requires the admin token', async () => {
  const res = await request(app).post('/bot-admin/listings/bulk').send({ action: 'approve', ids: [ID1] });
  assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  assert.equal(listings.get(ID1).moderation_status, 'pending');
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

test('the page carries no inline script and no inline handlers', async () => {
  // The API sets script-src 'self' and script-src-attr 'none'. The first
  // version of this page used an inline <script> and onclick attributes: it
  // rendered perfectly and every handler was silently refused. supertest does
  // not enforce CSP, so only a real browser caught it — this test is the guard
  // that stops it coming back.
  const res = await request(app).get('/bot-admin/review');
  assert.doesNotMatch(res.text, /<script(?![^>]*\bsrc=)/i, 'inline <script> would be blocked');
  assert.doesNotMatch(res.text, /\son[a-z]+\s*=/i, 'inline event handler would be blocked');
  assert.match(res.text, /<script src="review\.js">/);
});

test('the review script is served from the same origin so script-src self allows it', async () => {
  const res = await request(app).get('/bot-admin/review.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.match(res.text, /addEventListener/);
});

test('the page widens img-src to https so listing photos actually load', async () => {
  // Craigslist and Uloop photos are third-party URLs; under the app-wide
  // img-src 'self' data: every card would render blank.
  const res = await request(app).get('/bot-admin/review');
  const csp = res.headers['content-security-policy'] || '';
  assert.match(csp, /img-src[^;]*https:/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test('bulk approve binds a uuid array', async () => {
  await request(app).post('/bot-admin/listings/bulk').set(AUTH).send({ action: 'approve', ids: [ID1] });
  const q = sqls.find(x => /UPDATE listings/i.test(x));
  assert.match(q, /ANY\(\$1::uuid\[\]\)/, 'must cast to uuid[], not int[]');
});

test('bulk reject binds a uuid array too', async () => {
  await request(app).post('/bot-admin/listings/bulk').set(AUTH).send({ action: 'reject', ids: [ID1] });
  const q = sqls.find(x => /UPDATE listings/i.test(x));
  assert.match(q, /ANY\(\$1::uuid\[\]\)/);
});
