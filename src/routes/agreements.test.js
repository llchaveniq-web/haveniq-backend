'use strict';

// The shared roommate agreement is the CSUF differentiator — "the joint act of
// agreeing". These lock the mechanic that makes it a genuine agreement and not
// a one-sided notes doc: a rule is only "agreed" once BOTH roommates accept its
// current wording, and changing the wording asks them to agree again. HTTP test
// with pool/auth/content-filter stubbed via the require cache. node --test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const store = {};                                   // convId -> items[]
const members = { 'conv-1': new Set(['alice', 'bob']) };

inject('../db/pool', {
  query: async (sql, params = []) => {
    if (/CREATE TABLE/i.test(sql)) return { rows: [] };
    if (/FROM conversations/i.test(sql)) {
      const [cid, uid] = params;
      return { rows: members[cid] && members[cid].has(uid) ? [{ one: 1 }] : [] };
    }
    if (/SELECT items FROM shared_agreements/i.test(sql)) {
      const [cid] = params;
      return { rows: store[cid] ? [{ items: store[cid] }] : [] };
    }
    if (/INSERT INTO shared_agreements/i.test(sql)) {
      const [cid, itemsJson] = params;
      store[cid] = JSON.parse(itemsJson);
      return { rows: [] };
    }
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth:  (req, _res, next) => { req.user = { id: req.headers['x-test-uid'], first_name: req.headers['x-test-name'] || 'User' }; next(); },
  refuseBanned: (_req, _res, next) => next(),
});
inject('../lib/contentFilter', {
  screenMessage: (v) => ({ action: /BLOCKME/.test(v) ? 'block' : 'allow' }),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/agreements', require('./agreements'));

const put    = (uid, body) => request(app).put('/agreements/conv-1').set('x-test-uid', uid).send(body);
const accept = (uid, topic) => request(app).post('/agreements/conv-1/accept').set('x-test-uid', uid).send({ topic });
const ruleOf = (res, topic) => res.body.items.find(i => i.topic === topic);
const sortedAccepted = (rule) => [...new Set(rule.acceptedBy)].sort();

test.beforeEach(() => { for (const k of Object.keys(store)) delete store[k]; });

test('setting a rule seeds acceptedBy with only the setter (one-sided until agreed)', async () => {
  const res = await put('alice', { topic: 'Quiet hours', value: '11pm' });
  assert.equal(res.status, 200);
  assert.deepEqual(ruleOf(res, 'Quiet hours').acceptedBy, ['alice']);
});

test('the other roommate accepting makes it agreed by both', async () => {
  await put('alice', { topic: 'Dishes', value: 'daily' });
  const res = await accept('bob', 'Dishes');
  assert.equal(res.status, 200);
  assert.deepEqual(sortedAccepted(ruleOf(res, 'Dishes')), ['alice', 'bob']);
});

test('editing the wording resets agreement to just the editor', async () => {
  await put('alice', { topic: 'Guest policy', value: '2 nights' });
  await accept('bob', 'Guest policy');
  const res = await put('alice', { topic: 'Guest policy', value: '1 night' });
  assert.deepEqual(ruleOf(res, 'Guest policy').acceptedBy, ['alice']);
});

test('re-saving identical wording keeps the existing agreement intact', async () => {
  await put('alice', { topic: 'Temperature', value: '70F' });
  await accept('bob', 'Temperature');
  const res = await put('alice', { topic: 'Temperature', value: '70F' });
  assert.deepEqual(sortedAccepted(ruleOf(res, 'Temperature')), ['alice', 'bob']);
});

test('a non-member cannot agree', async () => {
  await put('alice', { topic: 'Pet policy', value: 'no pets' });
  const res = await accept('stranger', 'Pet policy');
  assert.equal(res.status, 403);
});

test('cannot agree to a rule that does not exist', async () => {
  const res = await accept('bob', 'Nonexistent');
  assert.equal(res.status, 404);
});
