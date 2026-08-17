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

// A per-conversation mutex simulating real Postgres row-level locking: a
// SELECT ... FOR UPDATE only resolves once any transaction currently
// holding that conversation's row has committed/rolled back. This is what
// lets the concurrency tests below actually PROVE the fix serializes
// concurrent writers (and would fail if the locking were ever removed),
// rather than just asserting the right SQL shape gets issued.
const locks = {}; // convId -> current lock promise, present while held
async function acquireLock(cid) {
  while (locks[cid]) await locks[cid];
  let release;
  locks[cid] = new Promise(r => { release = r; });
  return () => { delete locks[cid]; release(); };
}

// A one-shot, test-controlled pause point for the NEXT unlocked SELECT (i.e.
// the read that runs once a lock has already been acquired, or — in the
// unfixed code this guards against — the read that runs with no lock at
// all). Implicit timing (setImmediate etc.) can't reliably force two
// "concurrent" requests to interleave at the exact vulnerable window in a
// mock this fast — it was tried, and a version of this test kept passing
// even with the fix reverted. An explicit, externally-releasable gate makes
// the interleaving deterministic instead of timing-dependent.
let pendingGate = null; // { promise, markEntered } set by a test right before firing the paused request

// PUT and /accept now do their read-modify-write under a transaction
// (pool.connect() + BEGIN/FOR UPDATE/COMMIT) instead of plain pool.query —
// fixing a lost-update race where two roommates saving different rules in
// the same window could silently overwrite each other. The client mock
// shares the same `store` so behavior stays identical to before; only the
// SELECT/UPDATE queries move onto the client, while ensureTable's CREATE
// and isMember's conversations lookup stay on the plain pool.
inject('../db/pool', {
  query: async (sql, params = []) => {
    if (/CREATE TABLE/i.test(sql)) return { rows: [] };
    if (/FROM conversations/i.test(sql)) {
      const [cid, uid] = params;
      return { rows: members[cid] && members[cid].has(uid) ? [{ one: 1 }] : [] };
    }
    return { rows: [] };
  },
  connect: async () => {
    let release = null;
    return {
      query: async (sql, params = []) => {
        if (/^BEGIN$/i.test(sql)) return { rows: [] };
        if (/^COMMIT$/i.test(sql) || /^ROLLBACK$/i.test(sql)) {
          if (release) { release(); release = null; }
          return { rows: [] };
        }
        if (/INSERT INTO shared_agreements/i.test(sql) && /DO NOTHING/i.test(sql)) {
          const [cid] = params;
          if (!store[cid]) store[cid] = [];
          return { rows: [] };
        }
        if (/SELECT items FROM shared_agreements/i.test(sql)) {
          const [cid] = params;
          // Only the locking read (FOR UPDATE) takes the mutex — matches
          // real Postgres, where a plain SELECT never blocks on the lock.
          if (/FOR UPDATE/i.test(sql)) release = await acquireLock(cid);
          const result = { rows: store[cid] ? [{ items: store[cid] }] : [] };
          // If a test armed a gate, pause here (after the read, before this
          // request's write) until the test releases it — this is what
          // creates a deterministic interleaving window instead of an
          // implicit, timing-dependent one.
          if (pendingGate) {
            const g = pendingGate; pendingGate = null;
            g.markEntered();
            await g.promise;
          }
          return result;
        }
        if (/UPDATE shared_agreements SET items/i.test(sql)) {
          const [cid, itemsJson] = params;
          store[cid] = JSON.parse(itemsJson);
          return { rows: [] };
        }
        return { rows: [] };
      },
      release: () => {},
    };
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

// supertest/superagent requests are lazy — the HTTP call doesn't actually go
// out until you .then()/await the Test object. That's invisible for the
// sequential `await put(...)` calls elsewhere in this file, but it breaks
// the gate-based concurrency tests below: `await gate.entered` would hang
// forever waiting on a request that was never sent. `.end()` forces
// immediate dispatch while still handing back an awaitable promise.
function fire(req) {
  return new Promise((resolve, reject) => {
    req.end((err, res) => { if (err && !res) reject(err); else resolve(res); });
  });
}
const put    = (uid, body) => fire(request(app).put('/agreements/conv-1').set('x-test-uid', uid).send(body));
const accept = (uid, topic) => fire(request(app).post('/agreements/conv-1/accept').set('x-test-uid', uid).send({ topic }));
const ruleOf = (res, topic) => res.body.items.find(i => i.topic === topic);
const sortedAccepted = (rule) => [...new Set(rule.acceptedBy)].sort();

// Arms the pause gate and returns a promise that resolves once the next
// SELECT has entered it (i.e. that request has read its snapshot and is now
// parked, mid-transaction, waiting to be released).
function armGate() {
  let markEntered, release;
  const entered = new Promise(r => { markEntered = r; });
  const promise = new Promise(r => { release = r; });
  pendingGate = { promise, markEntered };
  return { entered, release };
}

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

// These two tests assert the actual mechanism, not just an outcome: a
// second write to the SAME conversation must not even be able to READ
// until the first write's transaction has committed. An end-state-only
// check ("did both rules survive?") was tried first and turned out
// unreliable in a mock this fast — the two writes still happened to land in
// a safe order almost every time even with the lock artificially removed
// (resuming a parked promise has far less overhead than a fresh supertest
// HTTP round trip, so the "first" request routinely finished before the
// "second" one even started reading, accidentally avoiding the race
// regardless of whether locking was present). Asserting that the second
// request's promise is still UNRESOLVED while the first is parked
// mid-transaction is what actually proves the row lock is real and
// load-bearing, and reliably fails if FOR UPDATE is ever removed.
test('a PUT genuinely blocks a concurrent PUT on the same conversation until the first commits', async () => {
  const gate = armGate();
  const pAlice = put('alice', { topic: 'Quiet hours', value: '11pm' });
  await gate.entered; // alice has read her snapshot and is now parked, holding the row lock

  let bobSettled = false;
  const pBob = put('bob', { topic: 'Guest policy', value: '2 nights max' }).then(res => { bobSettled = true; return res; });

  // Give bob's request plenty of real event-loop turns to reach the DB
  // layer if nothing were blocking it.
  await new Promise(r => setTimeout(r, 50));
  assert.equal(bobSettled, false, "bob's PUT completed before alice's transaction committed — the conversation row isn't actually locked");

  gate.release();
  const [resAlice, resBob] = await Promise.all([pAlice, pBob]);
  assert.equal(bobSettled, true);
  assert.equal(resAlice.status, 200);
  assert.equal(resBob.status, 200);

  // And now that it was forced to wait, bob's write is on top of alice's
  // already-committed one — the actual lost-update outcome this guards.
  const final = store['conv-1'] || [];
  assert.ok(final.find(i => i.topic === 'Quiet hours'), "alice's rule was lost");
  assert.ok(final.find(i => i.topic === 'Guest policy'), "bob's rule was lost");
});

test('an accept genuinely blocks a concurrent PUT on the same conversation until the first commits', async () => {
  await put('alice', { topic: 'Dishes', value: 'daily' });

  const gate = armGate();
  const pAccept = accept('bob', 'Dishes');
  await gate.entered; // the accept has read its snapshot and is parked, holding the row lock

  let putSettled = false;
  const pPut = put('bob', { topic: 'Noise', value: 'quiet after 10pm' }).then(res => { putSettled = true; return res; });

  await new Promise(r => setTimeout(r, 50));
  assert.equal(putSettled, false, "the concurrent PUT completed before the accept committed — the row isn't actually locked");

  gate.release();
  const [resAccept, resPut] = await Promise.all([pAccept, pPut]);
  assert.equal(putSettled, true);
  assert.equal(resAccept.status, 200);
  assert.equal(resPut.status, 200);

  const final = store['conv-1'] || [];
  assert.deepEqual(sortedAccepted(final.find(i => i.topic === 'Dishes')), ['alice', 'bob']);
  assert.ok(final.find(i => i.topic === 'Noise'), "bob's new rule was silently dropped by the concurrent accept");
});
