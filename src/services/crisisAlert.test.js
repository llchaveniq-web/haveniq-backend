const { test } = require('node:test');
const assert = require('node:assert');
const { maybeAlertCrisis, _resetForTest, DEBOUNCE_MS } = require('./crisisAlert');

function spies() {
  const emails = [], fetches = [];
  return {
    emails, fetches,
    sendEmail: async (a) => { emails.push(a); },
    fetchFn:   async (url, opts) => { fetches.push({ url, opts }); return { ok: true }; },
  };
}
const T0 = 1_700_000_000_000;

test('first crisis for a user → alerts (Discord + email)', async () => {
  _resetForTest();
  const s = spies();
  const r = await maybeAlertCrisis({ id: 'u1', first_name: 'Sam', email: 's@x.edu' }, 'c1',
    { now: () => T0, fetchFn: s.fetchFn, sendEmail: s.sendEmail, discordHook: 'https://d/hook', to: 'safety@x' });
  assert.strictEqual(r.alerted, true);
  assert.strictEqual(s.emails.length, 1);
  assert.strictEqual(s.emails[0].to, 'safety@x');
  assert.strictEqual(s.emails[0].studentId, 'u1');
  assert.strictEqual(s.fetches.length, 1);
});

test('same user again within the window → debounced (no second alert)', async () => {
  _resetForTest();
  const s = spies();
  const deps = { fetchFn: s.fetchFn, sendEmail: s.sendEmail, discordHook: 'h', to: 'x' };
  await maybeAlertCrisis({ id: 'u1', email: 'a@x' }, 'c1', { ...deps, now: () => T0 });
  const r2 = await maybeAlertCrisis({ id: 'u1', email: 'a@x' }, 'c1', { ...deps, now: () => T0 + DEBOUNCE_MS - 1 });
  assert.strictEqual(r2.alerted, false);
  assert.strictEqual(r2.reason, 'debounced');
  assert.strictEqual(s.emails.length, 1, 'only the first alert should email');
});

test('after the debounce window → alerts again', async () => {
  _resetForTest();
  const s = spies();
  const deps = { fetchFn: s.fetchFn, sendEmail: s.sendEmail, discordHook: 'h', to: 'x' };
  await maybeAlertCrisis({ id: 'u1', email: 'a@x' }, 'c1', { ...deps, now: () => T0 });
  const r2 = await maybeAlertCrisis({ id: 'u1', email: 'a@x' }, 'c1', { ...deps, now: () => T0 + DEBOUNCE_MS + 1 });
  assert.strictEqual(r2.alerted, true);
  assert.strictEqual(s.emails.length, 2);
});

test('different users are independent', async () => {
  _resetForTest();
  const s = spies();
  const deps = { now: () => T0, fetchFn: s.fetchFn, sendEmail: s.sendEmail, discordHook: 'h', to: 'x' };
  await maybeAlertCrisis({ id: 'u1', email: 'a@x' }, 'c', deps);
  const r = await maybeAlertCrisis({ id: 'u2', email: 'b@x' }, 'c', deps);
  assert.strictEqual(r.alerted, true);
  assert.strictEqual(s.emails.length, 2);
});

test('no Discord hook → no fetch, but still emails the safety inbox', async () => {
  _resetForTest();
  const s = spies();
  const r = await maybeAlertCrisis({ id: 'u9', email: 'z@x' }, 'c',
    { now: () => T0, fetchFn: s.fetchFn, sendEmail: s.sendEmail, discordHook: '', to: 'x' });
  assert.strictEqual(r.alerted, true);
  assert.strictEqual(s.fetches.length, 0);
  assert.strictEqual(s.emails.length, 1);
});

test('no user → no alert', async () => {
  _resetForTest();
  const s = spies();
  const r = await maybeAlertCrisis(null, 'c', { fetchFn: s.fetchFn, sendEmail: s.sendEmail });
  assert.strictEqual(r.alerted, false);
  assert.strictEqual(s.emails.length, 0);
});
