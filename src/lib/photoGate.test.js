// Faces only after a mutual match, enforced on the server (lib/photoGate.js).
// node --test.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { connectedSet } = require('./photoGate');

const fakePool = (rows, seen = []) => ({ query: async (sql, params) => { seen.push({ sql, params }); return { rows }; } });

test('returns the other side of each accepted request, as strings', async () => {
  const seen = [];
  const set = await connectedSet('me', ['a', 'b', 'c'], fakePool([{ other: 'a' }, { other: 'c' }], seen));
  assert.deepEqual([...set].sort(), ['a', 'c']);
  assert.match(seen[0].sql, /status = 'accepted'/);
  assert.deepEqual(seen[0].params, ['me', ['a', 'b', 'c']]);
});

test('no viewer or no ids: empty, and no query at all', async () => {
  const seen = [];
  assert.equal((await connectedSet(null, ['a'], fakePool([], seen))).size, 0);
  assert.equal((await connectedSet('me', [], fakePool([], seen))).size, 0);
  assert.equal(seen.length, 0);
});

test('a failing query hides photos rather than showing them', async () => {
  const orig = console.warn; console.warn = () => {};
  try {
    const set = await connectedSet('me', ['a'], { query: async () => { throw new Error('db down'); } });
    assert.equal(set.size, 0);
  } finally { console.warn = orig; }
});

// Every pre match surface that returns another student's photo goes through
// the gate. A new route that forgets it should fail here, not in production.
const GATED = ['routes/matches.js', 'routes/matchOfTheDay.js', 'routes/search.js',
  'routes/votes.js', 'routes/stories.js', 'routes/users.js', 'routes/groups.js'];
for (const f of GATED) {
  test(`${f} gates photos through connectedSet`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(src.includes("require('../lib/photoGate')"), `${f} does not use the photo gate`);
  });
}

test('quiz preview matches never send a photo', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'quiz.js'), 'utf8');
  const start = src.indexOf("router.post('/preview-matches'");
  const body = src.slice(start, src.indexOf('router.', start + 20)).replace(/\/\/.*$/gm, '');
  assert.equal(/photoUrl:\s*(r|c)\.photo_url/.test(body), false);
});
