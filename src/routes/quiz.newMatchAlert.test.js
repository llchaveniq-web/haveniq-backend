// "A new match just joined": the alert the Matches screen always promised and
// nothing sent. pool stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let newcomer = { email: 'new@csulb.edu', is_demo: false };
let claimable = null; // ids the throttle lets through; null = all asked for
let claimSql = '';
inject('../db/pool', {
  query: async (sql, params) => {
    if (/SELECT email, is_demo FROM users WHERE id = \$1/.test(sql)) return { rows: [newcomer] };
    if (/UPDATE users SET last_new_match_alert_at = NOW\(\)/.test(sql)) {
      claimSql = sql;
      const asked = params[0];
      return { rows: asked.filter(id => !claimable || claimable.includes(id)).map(id => ({ id })) };
    }
    return { rows: [], rowCount: 0 };
  },
});

// The real auth middleware refuses to load without JWT_SECRET, and nothing
// here goes through a route.
inject('../middleware/auth', {
  requireAuth: (_req, _res, next) => next(),
  optionalAuth: (_req, _res, next) => next(),
  refuseBanned: (_req, _res, next) => next(),
});

const { alertNewMatches, NEW_MATCH_ALERT_MIN } = require('./quiz');

test.beforeEach(() => { newcomer = { email: 'new@csulb.edu', is_demo: false }; claimable = null; claimSql = ''; });

test('tells each compatible student once, with their own score, and opens Matches', async () => {
  const sent = [];
  await alertNewMatches('n1', [{ recipientId: 'a', score: 82 }, { recipientId: 'b', score: 71 }],
    (id, p) => { sent.push({ id, p }); });
  assert.deepEqual(sent.map(s => s.id), ['a', 'b']);
  assert.match(sent[0].p.body, /82% compatible/);
  assert.equal(sent[0].p.data.screen, 'matches');
});

test('the throttle decides: a student already told today is not told again', async () => {
  claimable = ['b'];
  const sent = [];
  await alertNewMatches('n1', [{ recipientId: 'a', score: 90 }, { recipientId: 'b', score: 70 }], (id) => sent.push(id));
  assert.deepEqual(sent, ['b']);
  assert.match(claimSql, /INTERVAL '20 hours'/);
  assert.match(claimSql, /is_verified = TRUE/);
  assert.match(claimSql, /is_banned/);
});

test('a seeded or test account arriving alerts nobody', async () => {
  const sent = [];
  newcomer = { email: 'alex.chen@usc.edu', is_demo: true };
  await alertNewMatches('n1', [{ recipientId: 'a', score: 90 }], (id) => sent.push(id));
  newcomer = { email: 'demo+1@haveniq.test', is_demo: false };
  await alertNewMatches('n1', [{ recipientId: 'a', score: 90 }], (id) => sent.push(id));
  assert.deepEqual(sent, []);
});

test('one failed send does not stop the rest', async () => {
  const sent = [];
  const orig = console.error; console.error = () => {};
  try {
    await alertNewMatches('n1', [{ recipientId: 'a', score: 80 }, { recipientId: 'b', score: 80 }],
      async (id) => { if (id === 'a') throw new Error('down'); sent.push(id); });
  } finally { console.error = orig; }
  assert.deepEqual(sent, ['b']);
});

test('the bar is the bottom of the "surface" tier, not the feed floor', () => {
  assert.equal(NEW_MATCH_ALERT_MIN, 65);
});
