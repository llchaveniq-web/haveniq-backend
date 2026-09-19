// POST /webhooks/resend must accept events signed the way Resend signs them.
//
// Resend uses Svix / Standard Webhooks: headers svix-id, svix-timestamp and
// svix-signature, where the signature entry is "v1,<base64 HMAC-SHA256 of
// `${id}.${timestamp}.${body}`>" keyed with the base64 part of whsec_...
// The route only accepted "v1=<sig>", so every real event failed with a 401,
// no bounce or complaint was ever recorded, and Resend disabled the webhook.
// These tests sign with the real scheme, built by hand below so the test does
// not lean on a transitive dependency. Mounted exactly as server.js mounts it.
// pool stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let writes = [];
inject('../db/pool', { query: async (sql, params) => { writes.push({ sql, params }); return { rows: [], rowCount: 1 }; } });

const SECRET = 'whsec_' + Buffer.from('resend-signature-test-secret').toString('base64');
process.env.RESEND_WEBHOOK_SECRET = SECRET;

const express = require('express');
const request = require('supertest');
const app = express();
app.use('/webhooks/resend', express.raw({ type: 'application/json', limit: '64kb' }), (req, res, next) => {
  if (Buffer.isBuffer(req.body)) { req.rawBody = req.body; req.body = JSON.parse(req.body.toString('utf8')); }
  next();
}, require('./resendWebhook'));

function sign(body, { id = 'msg_1', ts = Math.floor(Date.now() / 1000), secret = SECRET, prefix = 'v1,' } = {}) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `${prefix}${sig}` };
}

async function post(body, headers) {
  let r = request(app).post('/webhooks/resend').set('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send(body);
}

const BOUNCE = JSON.stringify({ type: 'email.bounced', data: { to: ['ghost@usc.edu'], email_id: 'e1' } });

test.beforeEach(() => { writes = []; });

test('accepts an event signed exactly as Resend signs it ("v1,<sig>")', async () => {
  const orig = console.warn; console.warn = () => {};
  try {
    const res = await post(BOUNCE, sign(BOUNCE));
    assert.equal(res.status, 200);
    assert.ok(writes.length > 0, 'a real bounce must reach the database');
  } finally { console.warn = orig; }
});

test('several signatures in one header, as during a secret rotation', async () => {
  const good = sign(BOUNCE);
  const other = sign(BOUNCE, { secret: 'whsec_' + Buffer.from('an-old-secret').toString('base64') })['svix-signature'];
  const res = await post(BOUNCE, { ...good, 'svix-signature': `${other} ${good['svix-signature']}` });
  assert.equal(res.status, 200);
});

test('still accepts the "v1=<sig>" form it used to require', async () => {
  const res = await post(BOUNCE, sign(BOUNCE, { prefix: 'v1=' }));
  assert.equal(res.status, 200);
});

test('rejects a signature made with the wrong secret, and writes nothing', async () => {
  const orig = console.warn; console.warn = () => {};
  try {
    const res = await post(BOUNCE, sign(BOUNCE, { secret: 'whsec_' + Buffer.from('attacker').toString('base64') }));
    assert.equal(res.status, 401);
    assert.equal(writes.length, 0);
  } finally { console.warn = orig; }
});

test('rejects a body altered after signing', async () => {
  const orig = console.warn; console.warn = () => {};
  try {
    const headers = sign(BOUNCE);
    const res = await post(BOUNCE.replace('ghost@usc.edu', 'someone@csulb.edu'), headers);
    assert.equal(res.status, 401);
  } finally { console.warn = orig; }
});

test('rejects a replay outside the five minute window', async () => {
  const orig = console.warn; console.warn = () => {};
  try {
    const res = await post(BOUNCE, sign(BOUNCE, { ts: Math.floor(Date.now() / 1000) - 3600 }));
    assert.equal(res.status, 401);
  } finally { console.warn = orig; }
});
