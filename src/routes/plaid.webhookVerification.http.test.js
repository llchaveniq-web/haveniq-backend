// POST /plaid/webhook — signature verification.
//
// Previously this route processed ANY JSON body as if Plaid had sent it —
// no signature check at all, despite a comment admitting as much ("we keep
// validation light for sandbox; production should verify"). Now every
// request is verified against Plaid's real ES256 webhook-JWT scheme:
// header kid → fetch/cache the matching public key → verify signature →
// reject a stale JWT (replay guard) → reject unless request_body_sha256
// matches the ACTUAL raw body on this request.
//
// A real EC P-256 keypair is generated once for the whole file; the mocked
// Plaid client serves its public half as the JWK Plaid would normally
// publish, and tests sign real JWTs with the private half — this exercises
// the actual crypto.createPublicKey/jwt.verify path, not a stubbed verdict.
// node --test.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_thirty_two_chars_long_xxxx';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

process.env.PLAID_CLIENT_ID = 'test-client-id';
process.env.PLAID_SECRET = 'test-secret';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const KID = 'test-kid-1';
const JWK = publicKey.export({ format: 'jwk' });

let dbCalls = [];
inject('../db/pool', {
  query: async (sql, params = []) => {
    dbCalls.push({ sql, params });
    return { rows: [] };
  },
});

let verificationKeyCalls = 0;
// Extra keypair/kid used only by the caching test, so its cache-population
// from an earlier test can't make that test's "first call" already warm.
const { publicKey: publicKey2, privateKey: privateKey2 } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const KID2 = 'test-kid-2';
const JWK2 = publicKey2.export({ format: 'jwk' });
const KNOWN_KEYS = { [KID]: JWK, [KID2]: JWK2 };
class FakePlaidApi {
  webhookVerificationKeyGet({ key_id }) {
    verificationKeyCalls++;
    return Promise.resolve({ data: { key: KNOWN_KEYS[key_id] ?? null } });
  }
}
inject('plaid', {
  Configuration: class {},
  PlaidApi: FakePlaidApi,
  PlaidEnvironments: { sandbox: 'https://sandbox.plaid.com' },
  Products: { Auth: 'auth', Identity: 'identity', Transactions: 'transactions' },
  CountryCode: { Us: 'US' },
});
inject('../services/auditLog', { audit: async () => {} });
inject('../services/analytics', { track: () => {}, EVENTS: {} });

const express = require('express');
const request = require('supertest');
const app = express();
// Mirrors server.js's exact verify hook — rawBody is what the real
// signature check runs against.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use('/plaid', require('./plaid'));

test.beforeEach(() => {
  dbCalls = [];
  verificationKeyCalls = 0;
  delete process.env.NODE_ENV;
});

function signedToken(bodyObj, { kid = KID, iatOffsetSec = 0, key = privateKey } = {}) {
  const bodyStr = JSON.stringify(bodyObj);
  const request_body_sha256 = crypto.createHash('sha256').update(bodyStr).digest('hex');
  const iat = Math.floor(Date.now() / 1000) + iatOffsetSec;
  return {
    bodyStr,
    // NOTE: no noTimestamp option — jsonwebtoken respects a caller-supplied
    // `iat` in the payload either way, but noTimestamp:true actively
    // DELETES it instead of just skipping auto-add, which silently broke
    // every "iat" this helper set.
    token: jwt.sign({ request_body_sha256, iat }, key, {
      algorithm: 'ES256',
      header: { kid },
    }),
  };
}

const post = (bodyStr, token) =>
  request(app).post('/plaid/webhook')
    .set('Content-Type', 'application/json')
    .set(token ? { 'Plaid-Verification': token } : {})
    .send(bodyStr);

test('a correctly signed, fresh webhook is accepted and processes ITEM_REMOVED', async () => {
  const body = { webhook_type: 'ITEM', webhook_code: 'ITEM_REMOVED', item_id: 'item-123' };
  const { bodyStr, token } = signedToken(body);
  const res = await post(bodyStr, token);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const update = dbCalls.find(c => /UPDATE plaid_items SET is_active = FALSE/.test(c.sql));
  assert.ok(update, 'a verified ITEM_REMOVED webhook updates the row');
  assert.equal(update.params[0], 'item-123');
  assert.equal(verificationKeyCalls, 1);
});

test('the verification key is cached — a second webhook with the same kid does not refetch', async () => {
  const { bodyStr, token } = signedToken({ webhook_type: 'ITEM', webhook_code: 'PING' }, { kid: KID2, key: privateKey2 });
  await post(bodyStr, token);
  assert.equal(verificationKeyCalls, 1, 'first request for this kid fetched it');
  const { bodyStr: bodyStr2, token: token2 } = signedToken({ webhook_type: 'ITEM', webhook_code: 'PING' }, { kid: KID2, key: privateKey2 });
  await post(bodyStr2, token2);
  assert.equal(verificationKeyCalls, 1, 'second request for the SAME kid reused the cache — still 1');
});

test('a tampered body (hash mismatch) is rejected in production, never reaches the DB update', async () => {
  process.env.NODE_ENV = 'production';
  const body = { webhook_type: 'ITEM', webhook_code: 'ITEM_REMOVED', item_id: 'item-123' };
  const { token } = signedToken(body);
  // Sign for `body`, but send a DIFFERENT body over the wire.
  const tamperedBodyStr = JSON.stringify({ ...body, item_id: 'someone-elses-item' });
  const res = await post(tamperedBodyStr, token);
  assert.equal(res.status, 401);
  assert.equal(dbCalls.length, 0);
});

test('a stale JWT (issued 10 minutes ago) is rejected in production', async () => {
  process.env.NODE_ENV = 'production';
  const body = { webhook_type: 'ITEM', webhook_code: 'ITEM_REMOVED', item_id: 'item-123' };
  const { bodyStr, token } = signedToken(body, { iatOffsetSec: -10 * 60 });
  const res = await post(bodyStr, token);
  assert.equal(res.status, 401);
  assert.equal(dbCalls.length, 0);
});

test('a signature from the WRONG key is rejected in production', async () => {
  process.env.NODE_ENV = 'production';
  const { privateKey: wrongKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const body = { webhook_type: 'ITEM', webhook_code: 'ITEM_REMOVED', item_id: 'item-123' };
  const { bodyStr, token } = signedToken(body, { key: wrongKey }); // signed with a key Plaid never published under this kid
  const res = await post(bodyStr, token);
  assert.equal(res.status, 401);
  assert.equal(dbCalls.length, 0);
});

test('no Plaid-Verification header at all is rejected in production', async () => {
  process.env.NODE_ENV = 'production';
  const res = await post(JSON.stringify({ webhook_type: 'ITEM', webhook_code: 'ITEM_REMOVED', item_id: 'x' }), null);
  assert.equal(res.status, 401);
  assert.equal(dbCalls.length, 0);
});

test('an unsigned webhook is still ACCEPTED outside production (sandbox/dev leniency)', async () => {
  const res = await post(JSON.stringify({ webhook_type: 'ITEM', webhook_code: 'ITEM_REMOVED', item_id: 'item-999' }), null);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const update = dbCalls.find(c => /UPDATE plaid_items SET is_active = FALSE/.test(c.sql));
  assert.ok(update, 'still processed — this is the deliberate non-production leniency, matching identity.js\'s pattern');
});
