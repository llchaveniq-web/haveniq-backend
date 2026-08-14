// POST /admin/review/:userId/approve — the founder-side twin of
// botAdmin.approveScoring.http.test.js. Same reasoning: scoreNewMatches
// skips unverified submitters, so a founder approving a signup after the
// user already finished the quiz must trigger scoring immediately or their
// feed silently stays empty forever.
const test = require('node:test');
const assert = require('node:assert');

process.env.FOUNDER_USER_IDS = 'founder-1';
const FOUNDER = 'founder-1';

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let usersById = new Map();
let quizAnswersById = new Map();
let scoreNewMatchesCalls = [];

inject('../db/pool', {
  query: async (sql, params = []) => {
    if (/UPDATE users\s*\n\s*SET is_verified = TRUE\s*\n\s*WHERE id = \$1 AND email NOT LIKE/i.test(sql)) {
      const u = usersById.get(params[0]);
      if (!u) return { rows: [] };
      u.is_verified = true;
      return { rows: [{ id: u.id, email: u.email, first_name: u.first_name }] };
    }
    if (/SELECT answers FROM quiz_answers WHERE user_id = \$1 AND completed = TRUE/i.test(sql)) {
      const a = quizAnswersById.get(params[0]);
      return { rows: a ? [{ answers: a }] : [] };
    }
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, res, next) => {
    const uid = req.headers['x-test-uid'];
    req.user = uid ? { id: uid } : null;
    if (!req.user) return res.status(401).json({ error: 'unauth' });
    next();
  },
});
inject('./quiz', {
  scoreNewMatches: async (userId, answers) => { scoreNewMatchesCalls.push({ userId, answers }); },
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/admin', require('./admin'));

test.beforeEach(() => {
  usersById = new Map();
  quizAnswersById = new Map();
  scoreNewMatchesCalls = [];
});

const approve = (id) => request(app).post(`/admin/review/${id}/approve`).set('x-test-uid', FOUNDER);

test('founder approving a pending user who finished the quiz triggers scoring immediately', async () => {
  usersById.set('u-1', { id: 'u-1', email: 'real@berkeley.edu', first_name: 'Sam', is_verified: false });
  quizAnswersById.set('u-1', { 1: { type: 'option', index: 0 } });

  const res = await approve('u-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(scoreNewMatchesCalls.length, 1);
  assert.equal(scoreNewMatchesCalls[0].userId, 'u-1');
});

test('founder approving a pending user with no completed quiz does not call scoreNewMatches', async () => {
  usersById.set('u-2', { id: 'u-2', email: 'real2@berkeley.edu', first_name: 'Jo', is_verified: false });

  const res = await approve('u-2');
  assert.equal(res.status, 200);
  assert.equal(scoreNewMatchesCalls.length, 0);
});

test('a scoring failure does not fail the approve response', async () => {
  inject('./quiz', { scoreNewMatches: async () => { throw new Error('boom'); } });
  usersById.set('u-3', { id: 'u-3', email: 'real3@berkeley.edu', first_name: 'Ali', is_verified: false });
  quizAnswersById.set('u-3', { 1: { type: 'option', index: 0 } });

  const res = await approve('u-3');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  inject('./quiz', { scoreNewMatches: async (userId, answers) => { scoreNewMatchesCalls.push({ userId, answers }); } });
});
