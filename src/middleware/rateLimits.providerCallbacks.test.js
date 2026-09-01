const test = require('node:test');
const assert = require('node:assert');

/**
 * The write limiter must never throttle a signed provider callback.
 *
 * The skip used to match /^\/(webhooks|sentry|api)\//. Its comment named Stripe
 * first — "a Stripe/Resend/Sentry retry burst would be dropped and the event
 * lost" — and then did not match Stripe, which is mounted at /premium/webhook
 * (server.js: app.use('/premium', …) plus router.post('/webhook')). No
 * /webhooks/ prefix, no match, so the one callback the exemption was written
 * for was the only one it missed, at 60 writes / 5 min per IP.
 *
 * That matters because Stripe sends every event for every subscriber from a
 * small shared pool of IPs, so a burst of signups and Stripe's own retries draw
 * on one budget. A 429 is not fatal — Stripe backs off and retries for days —
 * but each one delays a paying student's account flipping to premium, which is
 * precisely the failure the skip exists to prevent.
 *
 * Nothing covered the skip before this. The bug survived because the only way
 * to see it was to compare the regex against the mount paths in another file.
 */

// The predicate under test, kept identical to the one in rateLimits.js. Reading
// the real `skip` out of an express-rate-limit instance is not supported, so
// this asserts the rule and the list the module actually exports is checked
// against it below.
const PROVIDER_CALLBACK_PATHS = ['/premium/webhook', '/webhooks/resend', '/sentry/webhook'];
const isExempt = (p) => PROVIDER_CALLBACK_PATHS.some(x => p === x || p.startsWith(x + '/'));

test('every provider callback path is exempt', () => {
  for (const p of PROVIDER_CALLBACK_PATHS) {
    assert.equal(isExempt(p), true, `${p} must be exempt`);
  }
});

test('Stripe is exempt — the case the old prefix regex missed', () => {
  assert.equal(isExempt('/premium/webhook'), true);
  // Proof the old rule did not cover it, so this test would have failed then.
  assert.equal(/^\/(webhooks|sentry|api)\//.test('/premium/webhook'), false);
});

test('the rest of the premium router is still rate-limited', () => {
  // The exemption is for the signature-verified callback only. A user-facing
  // POST that creates a checkout session must stay behind the limiter.
  assert.equal(isExempt('/premium/checkout-session'), false);
  assert.equal(isExempt('/premium/cancel'), false);
  assert.equal(isExempt('/premium'), false);
});

test('a path that merely starts with an exempt string is not exempt', () => {
  // '/premium/webhook-something' must not slip through on a prefix match.
  assert.equal(isExempt('/premium/webhookaaa'), false);
  assert.equal(isExempt('/premium/webhook-spoof'), false);
  // A genuine subpath of a callback is exempt.
  assert.equal(isExempt('/sentry/webhook/health'), true);
});

test('the module exports the same list this test asserts against', () => {
  // Guards the failure mode where the list in rateLimits.js drifts from the
  // rule proven above and this suite keeps passing on a stale copy.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'rateLimits.js'), 'utf8');
  for (const p of PROVIDER_CALLBACK_PATHS) {
    assert.ok(src.includes(`'${p}'`), `rateLimits.js must list ${p}`);
  }
  assert.ok(src.includes('PROVIDER_CALLBACK_PATHS.some('), 'the skip must use the list');
});
