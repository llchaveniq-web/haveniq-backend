// Web push: the pieces that decide what reaches a student's browser, and what
// this server will ever POST to. node --test, no network, no database.
const test = require('node:test');
const assert = require('node:assert');
const { urlFor, validSubscription, sendWebPushToUser } = require('./webPush');

const KEYS = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) };

test('a tap opens the same screen the phone app would', () => {
  assert.equal(urlFor({ screen: 'thread', conversationId: 'c 1' }), '/thread/c%201');
  assert.equal(urlFor({ screen: 'matches' }), '/matches');
  assert.equal(urlFor({ screen: 'messages' }), '/messages');
  assert.equal(urlFor({ screen: 'housing-browser', listingId: 42 }), '/listing/42');
  assert.equal(urlFor({ screen: 'circle' }), '/circle');
  assert.equal(urlFor({ screen: 'verify-edu' }), '/verify-edu');
  assert.equal(urlFor(undefined), '/home');
  assert.equal(urlFor({ screen: 'something-new' }), '/home');
});

test('every URL is a path on our own origin, never a place a payload chose', () => {
  for (const d of [{ screen: 'thread', conversationId: '//evil.com' }, { screen: 'checkin', id: 'https://x' }]) {
    const u = urlFor(d);
    assert.ok(u.startsWith('/') && !u.startsWith('//'), u);
  }
});

test('accepts subscriptions from every real browser push service', () => {
  for (const endpoint of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QOabc',
    'https://wns2-by3p.notify.windows.com/w/?token=abc',
  ]) assert.equal(validSubscription({ endpoint, keys: KEYS }), true, endpoint);
});

test('refuses anything that would make this server POST somewhere a client picked', () => {
  for (const endpoint of [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://evil.com/fcm/send/abc',
    'https://fcm.googleapis.com.evil.com/x',
    'https://notfcm.googleapis.com.attacker.io/x',
    'https://169.254.169.254/latest/meta-data',
    'not a url',
  ]) assert.equal(validSubscription({ endpoint, keys: KEYS }), false, endpoint);
});

test('refuses a subscription missing its encryption keys', () => {
  assert.equal(validSubscription({ endpoint: 'https://fcm.googleapis.com/x' }), false);
  assert.equal(validSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'x' } }), false);
  assert.equal(validSubscription(null), false);
});

function fakePool(subs) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT id, endpoint/.test(sql)) return { rows: subs };
      return { rows: [], rowCount: 1 };
    },
  };
}

test('sends to every browser the student turned alerts on in, and stamps success', async () => {
  const pool = fakePool([
    { id: 1, endpoint: 'https://fcm.googleapis.com/a', p256dh: 'p', auth: 'a' },
    { id: 2, endpoint: 'https://web.push.apple.com/b', p256dh: 'p', auth: 'a' },
  ]);
  const sent = [];
  const webpush = { sendNotification: async (sub, payload) => { sent.push({ sub, payload: JSON.parse(payload) }); } };
  const r = await sendWebPushToUser(pool, 'u1', { title: 'Hi', body: 'B', data: { screen: 'matches' } }, { webpush });
  assert.equal(r.sent, 2);
  assert.equal(sent[0].payload.url, '/matches');
  assert.equal(sent[0].payload.title, 'Hi');
  assert.equal(pool.calls.filter(c => /last_success_at = NOW\(\)/.test(c.sql)).length, 2);
});

test('a subscription the push service calls gone (410) is deleted, not retried forever', async () => {
  const pool = fakePool([{ id: 7, endpoint: 'https://fcm.googleapis.com/a', p256dh: 'p', auth: 'a' }]);
  const webpush = { sendNotification: async () => { const e = new Error('gone'); e.statusCode = 410; throw e; } };
  const r = await sendWebPushToUser(pool, 'u1', { title: 't' }, { webpush });
  assert.equal(r.sent, 0);
  assert.ok(pool.calls.some(c => /DELETE FROM web_push_subscriptions WHERE id = \$1$/.test(c.sql) && c.params[0] === 7));
});

test('a transient failure counts against the subscription instead of deleting it', async () => {
  const pool = fakePool([{ id: 9, endpoint: 'https://fcm.googleapis.com/a', p256dh: 'p', auth: 'a' }]);
  const webpush = { sendNotification: async () => { const e = new Error('busy'); e.statusCode = 503; throw e; } };
  const orig = console.error; console.error = () => {};
  try { await sendWebPushToUser(pool, 'u1', { title: 't' }, { webpush }); } finally { console.error = orig; }
  assert.ok(pool.calls.some(c => /failures = failures \+ 1/.test(c.sql)));
  assert.ok(pool.calls.some(c => /failures >= \$2/.test(c.sql)), 'drops it only once it has failed repeatedly');
});

test('a thread notification replaces the previous one for that thread instead of stacking', async () => {
  const pool = fakePool([{ id: 1, endpoint: 'https://fcm.googleapis.com/a', p256dh: 'p', auth: 'a' }]);
  let payload;
  const webpush = { sendNotification: async (_s, p) => { payload = JSON.parse(p); } };
  await sendWebPushToUser(pool, 'u1', { title: 't', data: { screen: 'thread', conversationId: 'c9' } }, { webpush });
  assert.equal(payload.tag, 'thread-c9');
});
