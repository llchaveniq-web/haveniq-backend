// HTTP-contract tests for the outcome-learning routes (Phases 2–4). DB + auth
// are stubbed via the require cache — no database. Verifies the public proof
// gating, the bot-gated review queue + metrics, and the FOUNDER gate on the
// human approve/reject lever. node --test.
const test = require('node:test');
const assert = require('node:assert');

process.env.ADMIN_BOT_TOKEN = 'test-bot-token';

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── Mutable fixtures ──
let outcomeRows = [];          // match_outcomes rows for calibration/proof/metrics
let pendingRows = [];          // weight_proposals pending
let proposalById = null;       // getById result for approve/reject

const fakePool = {
  query: async (sql, params = []) => {
    if (sql.includes('FROM match_outcomes')) return { rows: outcomeRows };
    if (sql.includes("status='pending'") && sql.startsWith('SELECT')) return { rows: pendingRows };
    if (sql.includes('FROM weight_proposals WHERE id')) return { rows: proposalById ? [proposalById] : [] };
    if (sql.startsWith('UPDATE weight_proposals')) return { rows: [{ id: params[0] }] };
    if (sql.includes('INSERT INTO weight_change_log')) return { rows: [{ id: 1, to_version: 'v9-learned-global-7' }] };
    if (sql.includes('FROM weight_change_log')) return { rows: [] };
    if (sql.includes('FROM learning_snapshots')) return { rows: [] };
    return { rows: [] }; // CREATE TABLE / everything else
  },
};
inject('../db/pool', fakePool);
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: req.headers['x-test-uid'] || 'user-1' }; next(); },
});
inject('../utils/founders', {
  isFounder: (id) => id === 'founder-1',
  isFounderEmail: () => false, isFounderUser: (u) => u && u.id === 'founder-1',
  getFounderIds: () => ['founder-1'], getFounderEmails: () => [],
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/', require('./weightLearning'));

const BOT = { Authorization: 'Bearer test-bot-token' };

test.beforeEach(() => { outcomeRows = []; pendingRows = []; proposalById = null; });

// Enough answered outcomes to clear the public bar (50), with a real spread.
function seedRealCohort() {
  const rows = [];
  const push = (n, score, stage, answer, rating) => {
    for (let i = 0; i < n; i++) rows.push({
      predicted_score: String(score), stage, answer: answer ?? null, rating: rating != null ? String(rating) : null,
    });
  };
  push(24, 92, 'meet48', 'yes');   // top band: 30 total, 24 success → 0.8
  push(6, 92, 'meet48', 'no');
  push(12, 60, 'meet48', 'yes');   // low band: 30 total, 12 success → 0.4
  push(18, 60, 'meet48', 'no');
  outcomeRows = rows;
}

// ── PUBLIC proof ────────────────────────────────────────────────────────────
test('GET /match-outcomes/proof: no data → { ok:false }, no auth required', async () => {
  const res = await request(app).get('/match-outcomes/proof');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: false });
});

test('GET /match-outcomes/proof: real cohort → honest headline', async () => {
  seedRealCohort();
  const res = await request(app).get('/match-outcomes/proof');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.multiple, 2);            // 0.8 / 0.4
  assert.ok(res.body.headline.includes('2×'));
});

test('GET /match-outcomes/proof: thin cohort (< public bar) → ok:false', async () => {
  outcomeRows = [
    { predicted_score: '92', stage: 'meet48', answer: 'yes', rating: null },
    { predicted_score: '60', stage: 'meet48', answer: 'no', rating: null },
  ];
  const res = await request(app).get('/match-outcomes/proof');
  assert.deepEqual(res.body, { ok: false });
});

// ── BOT gate ────────────────────────────────────────────────────────────────
test('bot routes require the bot token', async () => {
  assert.equal((await request(app).get('/bot-admin/weight-proposals')).status, 401);
  assert.equal((await request(app).get('/bot-admin/calibration-metrics')).status, 401);
});

test('GET /bot-admin/weight-proposals: lists the pending queue', async () => {
  pendingRows = [{ id: 7, scope: 'global', ready: true, decided: 320, fingerprint: 'x', status: 'pending' }];
  const res = await request(app).get('/bot-admin/weight-proposals').set(BOT);
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.proposals[0].scope, 'global');
});

test('GET /bot-admin/calibration-metrics: returns Brier/AUC/monotonic', async () => {
  seedRealCohort();
  const res = await request(app).get('/bot-admin/calibration-metrics').set(BOT);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.brier, 'number');
  assert.equal(typeof res.body.auc, 'number');
  assert.equal(res.body.monotonic, true);
  assert.ok(Array.isArray(res.body.bands));
});

// ── FOUNDER gate (the human commit lever) ───────────────────────────────────
test('approve/reject require a founder (403 for a normal user)', async () => {
  const a = await request(app).post('/weight-proposals/7/approve').set('x-test-uid', 'user-1').send({});
  assert.equal(a.status, 403);
  const r = await request(app).post('/weight-proposals/7/reject').set('x-test-uid', 'user-1').send({});
  assert.equal(r.status, 403);
});

test('founder approve: logs + returns weights to commit, never auto-applies', async () => {
  proposalById = {
    id: 7, scope: 'global', ready: true, status: 'pending', decided: 320,
    fingerprint: 'x', proposed: { 50: 48, 49: 34 }, base_version: 'v8',
  };
  const res = await request(app).post('/weight-proposals/7/approve').set('x-test-uid', 'founder-1').send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.weights, { 50: 48, 49: 34 });
  assert.ok(res.body.suggestedVersion.startsWith('v9-learned'));
  assert.ok(/scoring\.js/.test(res.body.note) && /quizStore/.test(res.body.note));
});

test('founder approve: refuses an unready (thin-cohort) proposal', async () => {
  proposalById = {
    id: 8, scope: 'global', ready: false, status: 'pending', decided: 20,
    fingerprint: 'y', proposed: { 50: 90 }, base_version: 'v8',
  };
  const res = await request(app).post('/weight-proposals/8/approve').set('x-test-uid', 'founder-1').send({});
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'not_ready');
});

test('founder approve: unknown proposal → 404', async () => {
  proposalById = null;
  const res = await request(app).post('/weight-proposals/9/approve').set('x-test-uid', 'founder-1').send({});
  assert.equal(res.status, 404);
});
