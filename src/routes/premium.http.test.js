// HTTP-level tests for the Premium (Stripe) endpoints. Stripe + DB + auth are
// stubbed via the require cache, so these run with no Stripe account, keys, or
// database. They verify the CONTRACT (validation, 503s, session shape, webhook
// grant/sync/revoke, status, cancel). The live Stripe TEST-MODE end-to-end
// (checkout → webhook → status → cancel) must be run by the founder with real
// test keys — see the report. node --test.
const test = require('node:test');
const assert = require('node:assert');

// Price env must be set before premium.js reads it (it reads at call time, so
// order is fine, but set early + a webhook secret so the webhook proceeds).
process.env.STRIPE_PRICE_PLUS_MONTHLY   = 'price_plus_m';
process.env.STRIPE_PRICE_PLUS_ANNUAL    = 'price_plus_a';
process.env.STRIPE_PRICE_PARENT_MONTHLY = 'price_parent_m';
process.env.STRIPE_WEBHOOK_SECRET       = 'whsec_test';
process.env.CLIENT_URL                  = 'https://app.haveniq.org';

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── Mutable fixtures the tests tweak ──
let userRow = { email: 'student@x.edu', stripe_customer_id: null };
let subRow  = null;             // subscriptions row for status/cancel
let dbCalls = [];
const find = (frag) => dbCalls.find(c => c.sql.includes(frag));

const fakePool = {
  query: async (sql, params = []) => {
    dbCalls.push({ sql, params });
    if (sql.includes('SELECT email, stripe_customer_id FROM users')) return { rows: userRow ? [userRow] : [] };
    if (sql.startsWith('UPDATE users SET stripe_customer_id')) return { rows: [] };
    if (sql.includes('INSERT INTO subscriptions')) return { rows: [] };
    if (sql.startsWith('UPDATE users SET is_premium')) return { rows: [] };
    if (sql.includes('SELECT status, plan, current_period_end FROM subscriptions')) return { rows: subRow ? [subRow] : [] };
    if (sql.includes('SELECT stripe_subscription_id FROM subscriptions')) {
      return { rows: subRow?.stripe_subscription_id ? [{ stripe_subscription_id: subRow.stripe_subscription_id }] : [] };
    }
    if (sql.includes('SELECT id FROM users WHERE stripe_customer_id')) return { rows: [{ id: 'user-123' }] };
    return { rows: [] };
  },
};

// Recording fake Stripe + a toggle for the "not configured" path.
let stripeReady = true;
const stripeCalls = { customers: [], sessions: [], retrieve: [], update: [] };
const fakeStripe = {
  customers: { create: async (a) => { stripeCalls.customers.push(a); return { id: 'cus_NEW' }; } },
  checkout: { sessions: { create: async (a) => { stripeCalls.sessions.push(a); return { id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' }; } } },
  subscriptions: {
    retrieve: async (id) => {
      stripeCalls.retrieve.push(id);
      return { id, status: 'active', metadata: { plan: 'plus', userId: 'user-123' },
               items: { data: [{ current_period_end: 1893456000, price: { id: 'price_plus_m' } }] } };
    },
    update: async (id, args) => { stripeCalls.update.push({ id, args }); return { id, ...args }; },
  },
  webhooks: { constructEvent: (body) => JSON.parse(Buffer.isBuffer(body) ? body.toString() : body) },
};
inject('../utils/stripe', { tryInit: () => (stripeReady ? fakeStripe : null), isReady: () => stripeReady });
inject('../db/pool', fakePool);
inject('../middleware/auth', {
  requireAuth: (req, res, next) => { req.user = { id: req.headers['x-test-uid'] || 'user-123' }; next(); },
});

const express = require('express');
const request = require('supertest');
const premium = require('./premium');

const app = express();
// Mirror server.js: the global JSON parser must SKIP /premium/webhook so the
// route's own express.raw() sees the raw body for signature verification.
const jsonParser = express.json();
app.use((req, res, next) => (req.path === '/premium/webhook' ? next() : jsonParser(req, res, next)));
app.use('/premium', premium);

test.beforeEach(() => {
  userRow = { email: 'student@x.edu', stripe_customer_id: null };
  subRow = null; dbCalls = [];
  stripeReady = true;
  stripeCalls.customers = []; stripeCalls.sessions = []; stripeCalls.retrieve = []; stripeCalls.update = [];
});

// ── helpers ──
const { priceIdFor, planFromPriceId, periodEndUnix } = premium._helpers;

test('helpers: priceIdFor maps plan+cadence, planFromPriceId reverses, parent:annual unmapped', () => {
  assert.equal(priceIdFor('plus', 'monthly'), 'price_plus_m');
  assert.equal(priceIdFor('plus', 'annual'), 'price_plus_a');
  assert.equal(priceIdFor('parent', 'monthly'), 'price_parent_m');
  assert.equal(priceIdFor('parent', 'annual'), null);
  assert.equal(planFromPriceId('price_parent_m'), 'parent');
  assert.equal(planFromPriceId('price_plus_a'), 'plus');
  assert.equal(planFromPriceId('price_unknown'), null);
});

test('helpers: periodEndUnix prefers item period, falls back to top-level', () => {
  assert.equal(periodEndUnix({ items: { data: [{ current_period_end: 111 }] } }), 111);
  assert.equal(periodEndUnix({ current_period_end: 222 }), 222);
  assert.equal(periodEndUnix({}), null);
});

// ── checkout-session ──
test('checkout: invalid plan/billing → 400', async () => {
  assert.equal((await request(app).post('/premium/checkout-session').send({ plan: 'gold', billing: 'monthly' })).status, 400);
  assert.equal((await request(app).post('/premium/checkout-session').send({ plan: 'plus', billing: 'weekly' })).status, 400);
});

test('checkout: parent + annual → 400 (not offered)', async () => {
  const res = await request(app).post('/premium/checkout-session').send({ plan: 'parent', billing: 'annual' });
  assert.equal(res.status, 400);
});

test('checkout: Stripe not configured → 503 (never a fake url)', async () => {
  stripeReady = false;
  const res = await request(app).post('/premium/checkout-session').send({ plan: 'plus', billing: 'monthly' });
  assert.equal(res.status, 503);
  assert.ok(!res.body.url);
});

test('checkout: valid → creates customer + session with mapped price, client_reference_id, metadata', async () => {
  const res = await request(app).post('/premium/checkout-session')
    .set('x-test-uid', 'user-123').send({ plan: 'plus', billing: 'annual' });
  assert.equal(res.status, 200);
  assert.equal(res.body.url, 'https://checkout.stripe.com/c/cs_1');
  // new customer created + persisted on the USER row
  assert.equal(stripeCalls.customers.length, 1);
  assert.ok(find('UPDATE users SET stripe_customer_id'));
  // session built per contract
  const s = stripeCalls.sessions[0];
  assert.equal(s.mode, 'subscription');
  assert.equal(s.customer, 'cus_NEW');
  assert.equal(s.line_items[0].price, 'price_plus_a');     // server-mapped, not client-sent
  assert.equal(s.client_reference_id, 'user-123');
  assert.deepEqual(s.metadata, { userId: 'user-123', plan: 'plus', billing: 'annual' });
  assert.ok(s.success_url.includes('/premium') && s.cancel_url.includes('/premium'));
});

test('checkout: reuses an existing Stripe customer (no duplicate create)', async () => {
  userRow = { email: 'student@x.edu', stripe_customer_id: 'cus_EXISTING' };
  const res = await request(app).post('/premium/checkout-session').send({ plan: 'parent', billing: 'monthly' });
  assert.equal(res.status, 200);
  assert.equal(stripeCalls.customers.length, 0, 'must not create a second customer');
  assert.equal(stripeCalls.sessions[0].customer, 'cus_EXISTING');
  assert.equal(stripeCalls.sessions[0].line_items[0].price, 'price_parent_m');
});

// ── webhook ──
const postWebhook = (payload) =>
  request(app).post('/premium/webhook').set('Content-Type', 'application/json')
    .set('stripe-signature', 't=1,v1=fake').send(JSON.stringify(payload));

test('webhook: checkout.session.completed grants premium', async () => {
  const res = await postWebhook({
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: 'user-123', customer: 'cus_NEW', subscription: 'sub_1', metadata: { plan: 'plus' } } },
  });
  assert.equal(res.status, 200);
  const ins = find('INSERT INTO subscriptions');
  assert.ok(ins, 'subscription row upserted');
  assert.equal(ins.params[0], 'user-123');     // user_id
  assert.equal(ins.params[3], 'active');        // status
  assert.equal(ins.params[4], 'plus');          // plan (logical, not price id)
  const flag = find('UPDATE users SET is_premium');
  assert.equal(flag.params[0], true);           // is_premium flipped on
});

test('webhook: customer.subscription.deleted revokes premium', async () => {
  const res = await postWebhook({
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_1', customer: 'cus_NEW', status: 'canceled', metadata: { userId: 'user-123', plan: 'plus' },
                      items: { data: [{ current_period_end: 1893456000, price: { id: 'price_plus_m' } }] } } },
  });
  assert.equal(res.status, 200);
  assert.equal(find('INSERT INTO subscriptions').params[3], 'canceled');
  assert.equal(find('UPDATE users SET is_premium').params[0], false);  // access revoked
});

test('webhook: customer.subscription.updated syncs status to past_due (loses access)', async () => {
  const res = await postWebhook({
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_1', customer: 'cus_NEW', status: 'past_due', metadata: { userId: 'user-123', plan: 'plus' },
                      items: { data: [{ current_period_end: 1893456000, price: { id: 'price_plus_m' } }] } } },
  });
  assert.equal(res.status, 200);
  assert.equal(find('INSERT INTO subscriptions').params[3], 'past_due');
  assert.equal(find('UPDATE users SET is_premium').params[0], false);
});

// ── status ──
test('status: no row → isPremium false, and the free tier still gets its quota', async () => {
  const res = await request(app).get('/premium/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    isPremium: false, plan: null, status: null, currentPeriodEnd: null,
    // A user with no subscription row is the free tier, and the app renders
    // "n of N left today" from exactly this. Omitting it here is what sent the
    // app back to its own device-local count — the bypass the ledger replaced.
    connects: { limit: 5, used: 0, remaining: 5, unlimited: false },
  });
});

test('status: active → premium, canceled → not, ISO period', async () => {
  subRow = { status: 'active', plan: 'plus', current_period_end: new Date('2026-08-01T00:00:00.000Z') };
  let res = await request(app).get('/premium/status');
  assert.deepEqual(res.body, {
    isPremium: true, plan: 'plus', status: 'active', currentPeriodEnd: '2026-08-01T00:00:00.000Z',
    // Unlimited must come back as nulls, not as a big number the UI might
    // print. Derived from the same isPremium above, so a premium badge and a
    // counted allowance can never be shown together.
    connects: { limit: null, used: 0, remaining: null, unlimited: true },
  });

  subRow = { status: 'canceled', plan: 'plus', current_period_end: new Date('2026-08-01T00:00:00.000Z') };
  res = await request(app).get('/premium/status');
  assert.equal(res.body.isPremium, false);
});

// ── cancel ──
test('cancel: sets cancel_at_period_end and returns success', async () => {
  subRow = { stripe_subscription_id: 'sub_1', status: 'active', plan: 'plus' };
  const res = await request(app).post('/premium/cancel');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true });
  assert.equal(stripeCalls.update.length, 1);
  assert.equal(stripeCalls.update[0].id, 'sub_1');
  assert.equal(stripeCalls.update[0].args.cancel_at_period_end, true);
});

test('cancel: no active subscription → 404', async () => {
  subRow = null;
  const res = await request(app).post('/premium/cancel');
  assert.equal(res.status, 404);
});
