// "A new match just joined": the alert the Matches screen always promised and
// nothing sent. pool stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let newcomer = { email: 'new@csulb.edu', is_demo: false, first_name: 'Jordan' };
let claimable = null; // ids the throttle lets through; null = all asked for
let claimSql = '';
let recipients = {};  // id -> { email, first_name, undeliverable } for the email path
let pushUsers = [];   // ids with a push subscription
inject('../db/pool', {
  query: async (sql, params) => {
    if (/SELECT email, is_demo, first_name FROM users WHERE id = \$1/.test(sql)) return { rows: [newcomer] };
    if (/UPDATE users SET last_new_match_alert_at = NOW\(\)/.test(sql)) {
      claimSql = sql;
      const asked = params[0];
      return { rows: asked.filter(id => !claimable || claimable.includes(id)).map(id => ({ id, ...(recipients[id] || {}) })) };
    }
    if (/FROM web_push_subscriptions/.test(sql)) return { rows: pushUsers.map(user_id => ({ user_id })) };
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

test.beforeEach(() => { newcomer = { email: 'new@csulb.edu', is_demo: false, first_name: 'Jordan' }; claimable = null; claimSql = ''; recipients = {}; pushUsers = []; });

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

// Push was the only channel, and on an iPhone push exists only once HavenIQ is
// on the Home Screen with alerts on. A student in Safari heard nothing when
// their first match arrived.
test('a student with no push subscription gets the match email instead', async () => {
  recipients = {
    a: { email: 'a@csulb.edu', first_name: 'Sam' },
    b: { email: 'b@csulb.edu', first_name: 'Ana' },
  };
  pushUsers = ['b'];
  const pushed = [], mailed = [];
  await alertNewMatches('n1', [{ recipientId: 'a', score: 82 }, { recipientId: 'b', score: 71 }],
    (id) => pushed.push(id), (...args) => mailed.push(args));
  assert.deepEqual(pushed.sort(), ['a', 'b']);            // the push still goes to everyone
  assert.equal(mailed.length, 1);                        // but only "a" had no way to get it
  assert.deepEqual(mailed[0].slice(0, 4), ['a@csulb.edu', 'Sam', 'Jordan', 82]);
});

test('no email to an address that bounced or complained', async () => {
  recipients = { a: { email: 'a@csulb.edu', first_name: 'Sam', undeliverable: true } };
  const mailed = [];
  await alertNewMatches('n1', [{ recipientId: 'a', score: 90 }], () => {}, (...args) => mailed.push(args));
  assert.equal(mailed.length, 0);
});

test('the throttle covers the email too: an already alerted student gets nothing', async () => {
  recipients = { a: { email: 'a@csulb.edu', first_name: 'Sam' } };
  claimable = [];                                        // the 20h stamp let nobody through
  const mailed = [];
  await alertNewMatches('n1', [{ recipientId: 'a', score: 90 }], () => {}, (...args) => mailed.push(args));
  assert.equal(mailed.length, 0);
});
