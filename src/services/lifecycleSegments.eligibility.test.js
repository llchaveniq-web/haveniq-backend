// Every lifecycle segment has to carry the eligibility gate.
//
// The lifecycle cron mailed dead addresses on a schedule for weeks. Read off
// the Resend API on 2026-09-23: of the last 100 sends, 27 were suppressed or
// bounced, and every single one was this job, at 00:27 UTC, on an 8-day cycle.
// Five seeded USC addresses, two reviewer accounts, a generated gmail and
// chad@haveniq.review, over and over.
//
// A young domain sending mail to invalid recipients on a repeating schedule is
// exactly the pattern a filter downranks, and the funnel it is downranking is
// the .edu verification code. The addresses were the cost; the reputation is
// the damage.
//
// What closed it is one clause. ELIGIBLE carries notDemo() and the
// undeliverable and opt-out checks, and every segment interpolates it. Nothing
// enforced that. A twelfth segment written next month, copied from a sibling
// with the WHERE reworked, brings the whole thing back, and it will not show up
// for eight days, in a dashboard nobody opens.
//
// So the rule is structural: a segment without the gate does not ship.
const test = require('node:test');
const assert = require('node:assert');

const { SEGMENTS, ACTIVE_USERS_SQL, ELIGIBLE } = require('./lifecycleSegments');
const { notDemo } = require('../lib/demoFilter');

test('the gate itself still does what its name says', () => {
  // Asserted on the composed SQL, not on the import. ELIGIBLE could keep the
  // require and drop the interpolation and nothing else here would notice.
  assert.ok(ELIGIBLE.includes(notDemo('u.email')),
    'ELIGIBLE no longer contains the demo-account filter');
  assert.match(ELIGIBLE, /email_undeliverable/,
    'ELIGIBLE no longer excludes addresses that bounced or complained');
  assert.match(ELIGIBLE, /lifecycle_opted_out/,
    'ELIGIBLE no longer honours one-click unsubscribe');
  assert.match(ELIGIBLE, /is_verified = TRUE/,
    'ELIGIBLE no longer requires a verified account');
});

test('there are segments to check, so a pass is not an empty check', () => {
  assert.ok(Array.isArray(SEGMENTS) && SEGMENTS.length > 0);
});

for (const seg of SEGMENTS) {
  test(`segment ${seg.id} carries the eligibility gate`, () => {
    assert.ok(typeof seg.sql === 'string' && seg.sql.length > 0, `${seg.id} has no sql`);
    assert.ok(seg.sql.includes(ELIGIBLE),
      `${seg.id} does not interpolate ELIGIBLE: it can mail demo accounts, ` +
      'unverified users, bounced addresses and people who unsubscribed');
  });

  test(`segment ${seg.id} respects the frequency cap`, () => {
    // Without it a re-run mails the same person twice, which reads as a broken
    // product to a real student and as noise to a filter.
    assert.match(seg.sql, /lifecycle_sends/,
      `${seg.id} does not check what was already sent`);
  });

  test(`segment ${seg.id} is bounded`, () => {
    // A missing LIMIT turns one bad query into the whole user table in one
    // batch, which is the shape of mistake the circuit breaker exists to
    // survive and should never have to.
    assert.match(seg.sql, /LIMIT \d+/, `${seg.id} has no LIMIT`);
  });
}

test('the circuit-breaker denominator counts eligible users only', () => {
  // If ACTIVE_USERS_SQL counted demo rows, the denominator would be inflated by
  // accounts that can never receive anything, and the breaker would let a
  // larger real blast through than intended.
  assert.ok(ACTIVE_USERS_SQL.includes(ELIGIBLE),
    'ACTIVE_USERS_SQL does not use the same gate the segments do');
});
