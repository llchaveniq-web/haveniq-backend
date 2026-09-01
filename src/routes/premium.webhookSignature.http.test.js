// POST /premium/webhook — REAL Stripe signature verification.
//
// premium.http.test.js covers what the webhook DOES (grants premium, revokes
// it, syncs status) but stubs the verification itself:
//
//   webhooks: { constructEvent: (body) => JSON.parse(body) }
//
// so it accepts `stripe-signature: t=1,v1=fake`. Event handling is proven;
// the signature path never was — and a wrong STRIPE_WEBHOOK_SECRET is the
// single most likely production failure for this route. It is silent from the
// student's side: their card is charged, Stripe records the payment, every
// delivery comes back 400, and the account never flips to premium.
//
// This suite uses the real `stripe` package to verify, and signs payloads the
// way Stripe does — v1 = HMAC-SHA256(secret, `${timestamp}.${payload}`) — so
// the acceptance path, the wrong-secret path and the replay window are all
// exercised against the library that runs in production.
//
// What it CANNOT tell you: whether the secret set in Railway matches the
// endpoint registered in the Stripe dashboard. Nothing offline can. That
// still takes one real purchase.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const SECRET = 'whsec_' + 'a1b2c3d4e5f6'.repeat(4);
process.env.STRIPE_WEBHOOK_SECRET = SECRET;
process.env.STRIPE_PRICE_PLUS_MONTHLY = 'price_plus_m';

let flipped = [];   // every UPDATE users SET is_premium, in order
const fakePool = {
  query: async (sql, params = []) => {
    if (sql.startsWith('UPDATE users SET is_premium')) flipped.push(params);
    if (sql.includes('SELECT id FROM users WHERE stripe_customer_id')) return { rows: [{ id: 'user-123' }] };
    return { rows: [] };
  },
};

// The real library does the verifying; only the API calls are faked.
const realStripe = require('stripe');
const fakeStripe = {
  webhooks: realStripe.webhooks,
  subscriptions: {
    retrieve: async (id) => ({
      id, status: 'active', metadata: { plan: 'plus', userId: 'user-123' },
      items: { data: [{ current_period_end: 1893456000, price: { id: 'price_plus_m' } }] },
    }),
  },
};
inject('../utils/stripe', { tryInit: () => fakeStripe, isReady: () => true });
inject('../db/pool', fakePool);
inject('../middleware/auth', { requireAuth: (req, _res, next) => { req.user = { id: 'user-123' }; next(); } });

const express = require('express');
const request = require('supertest');
const premium = require('./premium');

const app = express();
const jsonParser = express.json();
app.use((req, res, next) => (req.path === '/premium/webhook' ? next() : jsonParser(req, res, next)));
app.use('/premium', premium);

/** Sign exactly as Stripe does. */
function sign(payload, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

const EVENT = JSON.stringify({
  id: 'evt_1', type: 'checkout.session.completed',
  data: { object: {
    id: 'cs_1', customer: 'cus_1', subscription: 'sub_1',
    client_reference_id: 'user-123',
    metadata: { userId: 'user-123', plan: 'plus', billing: 'monthly' },
  } },
});

const post = (payload, sig) =>
  request(app).post('/premium/webhook')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', sig)
    .send(payload);

test.beforeEach(() => { flipped = []; });

test('a correctly signed event is accepted and grants premium', async () => {
  const res = await post(EVENT, sign(EVENT));
  assert.equal(res.status, 200, 'a valid Stripe signature must be accepted');
  assert.ok(flipped.length > 0, 'the user should have been flipped to premium');
});

test('the WRONG signing secret is rejected — the Railway-mismatch failure', async () => {
  // Exactly what happens when the endpoint's secret in Stripe does not match
  // STRIPE_WEBHOOK_SECRET: a real Stripe delivery, signed with a real secret,
  // that this server cannot verify.
  const res = await post(EVENT, sign(EVENT, { secret: 'whsec_' + 'f'.repeat(48) }));
  assert.equal(res.status, 400, 'a mismatched secret must be rejected, not silently accepted');
  assert.equal(flipped.length, 0, 'nobody may be granted premium on an unverified event');
});

test('a tampered body is rejected even with a valid-looking signature', async () => {
  const sig = sign(EVENT);
  const tampered = EVENT.replace('"user-123"', '"attacker"');
  const res = await post(tampered, sig);
  assert.equal(res.status, 400);
  assert.equal(flipped.length, 0);
});

test('a missing signature header is rejected', async () => {
  const res = await request(app).post('/premium/webhook')
    .set('Content-Type', 'application/json').send(EVENT);
  assert.equal(res.status, 400);
  assert.equal(flipped.length, 0);
});

test('a replayed event outside the tolerance window is rejected', async () => {
  // Stripe's default tolerance is 300s. An hour-old signature must not pass.
  const old = Math.floor(Date.now() / 1000) - 3600;
  const res = await post(EVENT, sign(EVENT, { timestamp: old }));
  assert.equal(res.status, 400, 'an expired timestamp must be rejected');
  assert.equal(flipped.length, 0);
});

test('the raw body survives — the parser-order failure', async () => {
  // If a JSON parser runs before the route's express.raw(), req.body is an
  // object and the HMAC is computed over different bytes, so every delivery
  // 400s with a valid secret. Signing and accepting the exact bytes proves
  // the raw body reached constructEvent intact.
  const spaced = JSON.stringify(JSON.parse(EVENT), null, 2);  // same data, different bytes
  const res = await post(spaced, sign(spaced));
  assert.equal(res.status, 200, 'verification must run over the exact bytes received');
  assert.ok(flipped.length > 0);
});
