// Regression: PATCH /users/me must accept the exact values GET /users/me
// returns. The validator enums drifted to an invented lowercase vocabulary
// ('male','junior','same_gender') the app never used — the app writes human
// labels ('Man','Junior', gender labels in lookingFor) — so re-saving an
// UNCHANGED field 400'd. This pins the round-trip. auth/pool stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let updates = [];
inject('../db/pool', {
  query: async (sql, params) => {
    if (/UPDATE users SET/.test(sql)) { updates.push({ sql, params }); return { rows: [{ id: 'u1' }], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'u1', email: 'a@ohio.edu', school: 'Ohio University' }; next(); },
  refuseBanned: (_q, _s, n) => n(),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/users', require('./users'));

const patch = (body) => request(app).patch('/users/me').send(body);

// The exact shape GET /users/me returns for a real user (verified in prod).
test('the real read-shape round-trips: {schoolYear:Junior, gender:Man, lookingFor:[Man]}', async () => {
  const res = await patch({ schoolYear: 'Junior', gender: 'Man', lookingFor: ['Man'] });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(!res.body.error, 'no "Invalid fields" rejection');
});

test('every app-offered school year is accepted', async () => {
  for (const y of ['Freshman', 'Sophomore', 'Junior', 'Senior', 'Graduate Student', 'Other']) {
    assert.equal((await patch({ schoolYear: y })).status, 200, `schoolYear ${y}`);
  }
});

test('every app-offered gender is accepted', async () => {
  for (const g of ['Man', 'Woman', 'Non-binary', 'Prefer not to say']) {
    assert.equal((await patch({ gender: g })).status, 200, `gender ${g}`);
  }
});

test('lookingFor accepts the gender labels the app sends', async () => {
  assert.equal((await patch({ lookingFor: ['Man', 'Woman', 'Non-binary'] })).status, 200);
});

test('legacy lowercase values still round-trip (existing rows not locked out)', async () => {
  assert.equal((await patch({ schoolYear: 'junior', gender: 'male', lookingFor: ['same_gender'] })).status, 200);
});

test('dealbreakers (already aligned) still accepted', async () => {
  assert.equal((await patch({ dealbreakers: ['sleep', 'cleanliness', 'noise'] })).status, 200);
});

test('genuine garbage is still rejected — the whitelist did not become a passthrough', async () => {
  const res = await patch({ gender: 'Wizard' });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(res.body), /gender/i);
});

test('a too-long bio is still rejected (unrelated validators intact)', async () => {
  assert.equal((await patch({ bio: 'x'.repeat(2001) })).status, 400);
});
