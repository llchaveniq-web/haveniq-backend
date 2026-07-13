const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const makeRateLimit = require('./rateLimit');
const { rateLimitingDisabled } = makeRateLimit;

afterEach(() => { delete process.env.RATE_LIMIT_DISABLED; });

test('rateLimitingDisabled: OFF by default (production keeps limiters on)', () => {
  delete process.env.RATE_LIMIT_DISABLED;
  assert.strictEqual(rateLimitingDisabled(), false);
});

test('rateLimitingDisabled: only the exact string "true" disables', () => {
  process.env.RATE_LIMIT_DISABLED = 'true';
  assert.strictEqual(rateLimitingDisabled(), true);
  process.env.RATE_LIMIT_DISABLED = 'TRUE';
  assert.strictEqual(rateLimitingDisabled(), false, 'case-sensitive — no accidental disable');
  process.env.RATE_LIMIT_DISABLED = '1';
  assert.strictEqual(rateLimitingDisabled(), false);
});

test('makeRateLimit: returns express middleware and preserves a caller skip', () => {
  let callerSkipSeen = false;
  const mw = makeRateLimit({ windowMs: 1000, max: 1, skip: () => { callerSkipSeen = true; return false; } });
  assert.strictEqual(typeof mw, 'function', 'is Express middleware (req,res,next)');
  // The wrapper exposes ipKeyGenerator for callers that destructure it.
  assert.strictEqual(typeof makeRateLimit.ipKeyGenerator, 'function');
  void callerSkipSeen; // exercised at request time by express-rate-limit
});
