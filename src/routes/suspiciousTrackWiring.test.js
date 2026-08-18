// Guard: candidate-pool routes that do real per-request DB/compute work must
// carry a suspicious-activity tracker (audit log + PostHog alert on repeat
// hammering — see middleware/suspiciousActivity.js; it never blocks, it just
// makes abuse discoverable). /feed already had one; an audit found /suites —
// which runs a heavier O(pool²) suite-optimization pass on top of its own
// queries — had none at all, the one candidate-pool route with zero
// visibility into repeat hits. Walks the real Express router's internal
// stack rather than firing dozens of requests to trip a threshold — each
// route's tracker is built fresh per call to suspicious.track(...) (a new
// closure, not a shared singleton like aiLimiter), so this checks the
// middleware function's name rather than referential identity.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_thirty_two_chars_long_xxxx';

const { test } = require('node:test');
const assert = require('node:assert');

function middlewareNamesFor(router, method, path) {
  const layer = router.stack.find(
    l => l.route && l.route.path === path && l.route.methods[method]
  );
  assert.ok(layer, `no ${method.toUpperCase()} ${path} route found on this router`);
  return layer.route.stack.map(s => s.handle);
}

test('matches.js: /feed and /suites both carry a suspicious-activity tracker', () => {
  const matches = require('./matches');
  for (const path of ['/feed', '/suites']) {
    const handles = middlewareNamesFor(matches, 'get', path);
    assert.ok(
      handles.some(h => h.name === 'trackMiddleware'),
      `GET ${path} must include a suspicious.track(...) middleware in its chain`,
    );
  }
});
