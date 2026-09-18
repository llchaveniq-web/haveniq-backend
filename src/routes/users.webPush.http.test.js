// /users/me/web-push: storing and removing a browser's alert subscription.
// Same harness as users.pushToken.http.test.js. pool/auth stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let calls = [];
let currentUser = { id: 'u1', email: 'a@csulb.edu', is_banned: false };
inject('../db/pool', {
  query: async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = currentUser; next(); },
  refuseBanned: (req, res, next) => (req.user?.is_banned ? res.status(403).json({ banned: true }) : next()),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/users', require('./users'));

const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } };

test.beforeEach(() => { calls = []; currentUser = { id: 'u1', email: 'a@csulb.edu', is_banned: false }; });

test('saves a real subscription for the signed in student', async () => {
  const res = await request(app).post('/users/me/web-push').send({ subscription: SUB });
  assert.equal(res.status, 200);
  const ins = calls.find(c => /INSERT INTO web_push_subscriptions/.test(c.sql));
  assert.ok(ins);
  assert.equal(ins.params[0], 'u1');
  assert.equal(ins.params[1], SUB.endpoint);
  assert.match(ins.sql, /ON CONFLICT \(endpoint\) DO UPDATE/, 'the same browser re-subscribing updates, it does not pile up rows');
});

test('refuses an endpoint that is not a push service, and writes nothing', async () => {
  const res = await request(app).post('/users/me/web-push')
    .send({ subscription: { ...SUB, endpoint: 'https://attacker.example/collect' } });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('removing is scoped to this browser AND this student', async () => {
  const res = await request(app).delete('/users/me/web-push').send({ endpoint: SUB.endpoint });
  assert.equal(res.status, 200);
  assert.deepEqual(calls[0].params, [SUB.endpoint, 'u1']);
});

test('the key route says null when web push is not configured, so the app never asks for it', async () => {
  const saved = { pub: process.env.VAPID_PUBLIC_KEY, priv: process.env.VAPID_PRIVATE_KEY };
  delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY;
  require('../services/webPush')._resetForTests();
  try {
    const res = await request(app).get('/users/me/web-push/key');
    assert.equal(res.status, 200);
    assert.equal(res.body.publicKey, null);
  } finally {
    if (saved.pub) process.env.VAPID_PUBLIC_KEY = saved.pub;
    if (saved.priv) process.env.VAPID_PRIVATE_KEY = saved.priv;
    require('../services/webPush')._resetForTests();
  }
});
