// plaid_items.access_token encryption at rest (lib/plaidCrypto.js).
//
// Was stored as plain TEXT — the migration's own comment admitted it
// ("in production we should encrypt at rest... but sandbox usage doesn't
// expose real money"), which was itself wrong: sandbox or not, this is the
// server-side secret that can pull a real connected user's transaction and
// identity data from Plaid. These lock: POST /exchange stores an encrypted
// value (not the raw token Plaid returned), GET /transactions and
// POST /disconnect both decrypt correctly before calling Plaid, a decrypt
// failure fails closed (never calls Plaid with null/garbage), and a legacy
// plaintext row (written before this fix) still reads correctly. node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

process.env.PLAID_CLIENT_ID = 'test-client-id';
process.env.PLAID_SECRET = 'test-secret';

const USER = '11111111-1111-1111-1111-111111111111';
const RAW_TOKEN = 'access-sandbox-real-plaintext-token';

let insertedParams = null;
let selectRows = [];
let itemRemoveCalls = [];
let transactionsGetCalls = [];

class FakePlaidApi {
  itemPublicTokenExchange() {
    return Promise.resolve({ data: { access_token: RAW_TOKEN, item_id: 'item-1' } });
  }
  itemGet() { return Promise.resolve({ data: { item: { institution_id: 'ins_1' } } }); }
  institutionsGetById() { return Promise.resolve({ data: { institution: { name: 'Test Bank' } } }); }
  accountsGet() { return Promise.resolve({ data: { accounts: [{ mask: '1234' }] } }); }
  transactionsGet(args) {
    transactionsGetCalls.push(args);
    return Promise.resolve({ data: { transactions: [] } });
  }
  itemRemove(args) {
    itemRemoveCalls.push(args);
    return Promise.resolve({ data: {} });
  }
}
inject('plaid', {
  Configuration: class {},
  PlaidApi: FakePlaidApi,
  PlaidEnvironments: { sandbox: 'https://sandbox.plaid.com' },
  Products: { Auth: 'auth', Identity: 'identity', Transactions: 'transactions' },
  CountryCode: { Us: 'US' },
});
inject('../db/pool', {
  query: async (sql, params = []) => {
    if (/INSERT INTO plaid_items/i.test(sql)) {
      insertedParams = params;
      return { rows: [] };
    }
    if (/SELECT access_token, institution_name FROM plaid_items/i.test(sql)) {
      return { rows: selectRows };
    }
    if (/SELECT access_token FROM plaid_items/i.test(sql)) {
      return { rows: selectRows };
    }
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: USER }; next(); },
});
inject('../services/auditLog', { audit: async () => {} });
inject('../services/analytics', { track: () => {}, EVENTS: {} });

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/plaid', require('./plaid'));
const { encryptToken } = require('../lib/plaidCrypto');

test.beforeEach(() => {
  insertedParams = null;
  selectRows = [];
  itemRemoveCalls = [];
  transactionsGetCalls = [];
  delete process.env.PLAID_TOKEN_ENC_KEY;
});

test('POST /exchange stores an ENCRYPTED access_token, not the raw value Plaid returned', async () => {
  process.env.PLAID_TOKEN_ENC_KEY = 'a-strong-32+char-key-for-testing-000';
  const res = await request(app).post('/plaid/exchange').send({ publicToken: 'public-abc' });
  assert.equal(res.status, 200);
  assert.ok(insertedParams, 'the row should have been inserted');
  const storedToken = insertedParams[2]; // (user_id, plaid_item_id, access_token, ...)
  assert.notEqual(storedToken, RAW_TOKEN, 'must not store the plaintext token');
  assert.match(storedToken, /^enc:v1:/, 'stored form carries the encryption prefix');
});

test('POST /exchange stores plaintext when no encryption key is configured (deploy-safe, not the security default)', async () => {
  const res = await request(app).post('/plaid/exchange').send({ publicToken: 'public-abc' });
  assert.equal(res.status, 200);
  assert.equal(insertedParams[2], RAW_TOKEN, 'no key set → falls back to plaintext, same as before this fix');
});

test('GET /transactions decrypts the stored token before calling Plaid', async () => {
  process.env.PLAID_TOKEN_ENC_KEY = 'a-strong-32+char-key-for-testing-000';
  selectRows = [{ access_token: encryptToken(RAW_TOKEN), institution_name: 'Test Bank' }];
  const res = await request(app).get('/plaid/transactions');
  assert.equal(res.status, 200);
  assert.equal(transactionsGetCalls.length, 1);
  assert.equal(transactionsGetCalls[0].access_token, RAW_TOKEN, 'Plaid must receive the real token, not ciphertext');
});

test('GET /transactions reads a LEGACY plaintext row correctly even with a key configured (backward compatible)', async () => {
  process.env.PLAID_TOKEN_ENC_KEY = 'a-strong-32+char-key-for-testing-000';
  selectRows = [{ access_token: RAW_TOKEN, institution_name: 'Test Bank' }]; // no enc:v1: prefix — written before this fix
  const res = await request(app).get('/plaid/transactions');
  assert.equal(res.status, 200);
  assert.equal(transactionsGetCalls[0].access_token, RAW_TOKEN);
});

test('GET /transactions fails closed on a decrypt failure — never calls Plaid with a bad token', async () => {
  process.env.PLAID_TOKEN_ENC_KEY = 'the-key-it-was-encrypted-under-aaaa';
  const encrypted = encryptToken(RAW_TOKEN);
  selectRows = [{ access_token: encrypted, institution_name: 'Test Bank' }];
  process.env.PLAID_TOKEN_ENC_KEY = 'a-DIFFERENT-key-now-bbbbbbbbbbbbbbb';
  const res = await request(app).get('/plaid/transactions');
  assert.equal(res.status, 500);
  assert.equal(transactionsGetCalls.length, 0, 'must never reach Plaid with a null/garbage token');
});

test('POST /disconnect decrypts before calling itemRemove', async () => {
  process.env.PLAID_TOKEN_ENC_KEY = 'a-strong-32+char-key-for-testing-000';
  selectRows = [{ access_token: encryptToken(RAW_TOKEN) }];
  const res = await request(app).post('/plaid/disconnect');
  assert.equal(res.status, 200);
  assert.equal(itemRemoveCalls.length, 1);
  assert.equal(itemRemoveCalls[0].access_token, RAW_TOKEN);
});

test('POST /disconnect skips the Plaid call (but still proceeds) when a row cannot be decrypted', async () => {
  process.env.PLAID_TOKEN_ENC_KEY = 'the-key-it-was-encrypted-under-aaaa';
  const encrypted = encryptToken(RAW_TOKEN);
  selectRows = [{ access_token: encrypted }];
  process.env.PLAID_TOKEN_ENC_KEY = 'a-DIFFERENT-key-now-bbbbbbbbbbbbbbb';
  const res = await request(app).post('/plaid/disconnect');
  assert.equal(res.status, 200, 'the DB-side disconnect still succeeds');
  assert.equal(itemRemoveCalls.length, 0, 'never calls Plaid with a bad token');
});
