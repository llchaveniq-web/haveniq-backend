const { test } = require('node:test');
const assert = require('node:assert');
const { runSafetyDigest } = require('./safetyDigest');

// A fake db whose query() returns one aggregate row.
const dbReturning = (row) => ({ query: async () => ({ rows: [row] }) });
// A fetch spy that records the last call.
function fetchSpy() {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
  fn.calls = calls;
  return fn;
}

const FIXED_NOW = () => Date.parse('2026-07-08T00:00:00Z');

test('clean queue (0 open) → never pings, even with a hook set', async () => {
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.test/hook';
  const spy = fetchSpy();
  const r = await runSafetyDigest({ db: dbReturning({ open_total: 0, high_total: 0, oldest: null }), fetchFn: spy, now: FIXED_NOW });
  assert.strictEqual(r.pinged, false);
  assert.strictEqual(r.open, 0);
  assert.strictEqual(spy.calls.length, 0, 'must not POST when the queue is empty');
});

test('open backlog + hook set → pings Discord with the count and oldest age', async () => {
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.test/hook';
  const spy = fetchSpy();
  const oldest = '2026-07-05T00:00:00Z'; // 3 days before FIXED_NOW
  const r = await runSafetyDigest({ db: dbReturning({ open_total: 4, high_total: 2, oldest }), fetchFn: spy, now: FIXED_NOW });
  assert.strictEqual(r.pinged, true);
  assert.strictEqual(r.open, 4);
  assert.strictEqual(r.high, 2);
  assert.strictEqual(r.oldestDays, 3);
  assert.strictEqual(spy.calls.length, 1);
  const body = JSON.parse(spy.calls[0].opts.body);
  assert.match(body.embeds[0].description, /\*\*4\*\* report/);
  assert.match(body.embeds[0].description, /2 HIGH/);
  assert.strictEqual(body.embeds[0].color, 0xC0392B, 'red when a HIGH report is waiting');
});

test('open backlog but NO hook configured → counts, does not throw, does not ping', async () => {
  delete process.env.DISCORD_WEBHOOK_URL;
  const spy = fetchSpy();
  const r = await runSafetyDigest({ db: dbReturning({ open_total: 2, high_total: 0, oldest: '2026-07-07T00:00:00Z' }), fetchFn: spy, now: FIXED_NOW });
  assert.strictEqual(r.pinged, false);
  assert.strictEqual(r.open, 2);
  assert.strictEqual(spy.calls.length, 0);
});

test('open backlog with only medium reports → amber, no HIGH label', async () => {
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.test/hook';
  const spy = fetchSpy();
  const r = await runSafetyDigest({ db: dbReturning({ open_total: 1, high_total: 0, oldest: '2026-07-08T00:00:00Z' }), fetchFn: spy, now: FIXED_NOW });
  assert.strictEqual(r.pinged, true);
  const body = JSON.parse(spy.calls[0].opts.body);
  assert.strictEqual(body.embeds[0].color, 0xE67E22, 'amber when nothing acute is waiting');
  assert.doesNotMatch(body.embeds[0].description, /HIGH/);
  assert.match(body.embeds[0].description, /\*\*1\*\* report still open/);
});
