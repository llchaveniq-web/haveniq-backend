// GET /circle/me — was one-sided (only people I invited); now symmetric via
// a UNION ALL of both referral directions, so the person who invited ME also
// shows up, labeled 'was_invited_by' instead of 'invited'. A invited B is
// already a real, mutual, known fact the moment it happens; this just fixes
// which side of it could see it. No new table, no new consent step.
// pool/auth stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let rows = [];
let lastSql = '';
let lastParams = [];
let throwOnQuery = false;
inject('../db/pool', {
  query: async (sql, params) => {
    if (throwOnQuery) throw new Error('db exploded');
    lastSql = sql;
    lastParams = params;
    return { rows };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'me-1' }; next(); },
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/circle', require('./circle'));

const get = () => request(app).get('/circle/me');

test.beforeEach(() => { rows = []; lastSql = ''; lastParams = []; throwOnQuery = false; });

test('the query unions both referral directions and orders by created_at', () => {
  return get().then(() => {
    assert.match(lastSql, /UNION ALL/);
    assert.match(lastSql, /'invited' AS direction/);
    assert.match(lastSql, /'was_invited_by' AS direction/);
    assert.match(lastSql, /WHERE r\.referrer_id = \$1/);
    assert.match(lastSql, /WHERE r\.referred_id = \$1/);
    assert.deepEqual(lastParams, ['me-1', 'me-1']);
  });
});

test('a person I invited is labeled "invited"', async () => {
  rows = [{
    user_id: 'friend-a', first_name: 'Jo', last_name: 'K.', photo_url: null,
    school_year: 'Sophomore', quiz_completed: false, score: null, direction: 'invited',
  }];
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.body.members[0].direction, 'invited');
});

test('the person who invited me is labeled "was_invited_by"', async () => {
  rows = [{
    user_id: 'friend-b', first_name: 'Sam', last_name: 'T.', photo_url: null,
    school_year: 'Junior', quiz_completed: false, score: null, direction: 'was_invited_by',
  }];
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.body.members[0].direction, 'was_invited_by');
});

test('a member in either direction still gets a real score once both quizzes are done', async () => {
  rows = [{
    user_id: 'friend-c', first_name: 'Ari', last_name: 'P.', photo_url: null,
    school_year: null, quiz_completed: true, score: '87.40', direction: 'was_invited_by',
  }];
  const res = await get();
  const m = res.body.members[0];
  assert.deepEqual(m.score, { finalPct: 87, tier: 'strong' });
});

test('no quiz yet -> score stays null regardless of direction', async () => {
  rows = [{
    user_id: 'friend-d', first_name: 'Lee', last_name: null, photo_url: null,
    school_year: null, quiz_completed: false, score: null, direction: 'invited',
  }];
  const res = await get();
  assert.equal(res.body.members[0].score, null);
});

test('a DB failure fails closed: ok:false, empty members, never a 500 blank crash', async () => {
  throwOnQuery = true;
  const res = await get();
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { ok: false, members: [] });
});

test('no referrals in either direction -> empty members, still ok:true', async () => {
  rows = [];
  const res = await get();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, members: [] });
});
