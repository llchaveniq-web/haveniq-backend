// Guard: every route that spends real Claude/paid-API budget must carry
// aiLimiter (or, for the offers click-billing route, quickAction) — an
// audit found the voice-interview pipeline (tts/transcribe/submit),
// /quiz/writing, and /quiz/submit had none, unlike every other AI-calling
// route in the app (matches.js's openers/explain). A later audit found the
// same gap in users.js: /me/photo/quality-check (uncached — every call is
// a real Claude vision hit) and /me/about-you (DB-cached on the user's own
// answers hash, so lower risk, but still worth the same defense). Walks
// the real Express router's internal stack rather than firing 40+
// requests to trip the limiter — this fails immediately if a future
// refactor drops the middleware from the route, which a behavioral test
// would only catch after re-sending dozens of requests.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_thirty_two_chars_long_xxxx';

const { test } = require('node:test');
const assert = require('node:assert');

const { aiLimiter, quickAction } = require('../middleware/rateLimits');

function middlewareNamesFor(router, method, path) {
  const layer = router.stack.find(
    l => l.route && l.route.path === path && l.route.methods[method]
  );
  assert.ok(layer, `no ${method.toUpperCase()} ${path} route found on this router`);
  return layer.route.stack.map(s => s.handle);
}

test('quiz.js: voice + writing + submit routes all carry aiLimiter', () => {
  const quiz = require('./quiz');
  for (const path of ['/voice/tts', '/voice/transcribe', '/voice/submit', '/writing', '/submit']) {
    const handles = middlewareNamesFor(quiz, 'post', path);
    assert.ok(handles.includes(aiLimiter), `POST ${path} must include aiLimiter in its middleware chain`);
  }
});

test('offers.js: click-billing route carries quickAction', () => {
  const offers = require('./offers');
  const handles = middlewareNamesFor(offers, 'post', '/:id/click');
  assert.ok(handles.includes(quickAction), 'POST /:id/click must include quickAction in its middleware chain');
});

test('users.js: the two Claude-calling routes carry aiLimiter', () => {
  const users = require('./users');
  const qualityCheck = middlewareNamesFor(users, 'post', '/me/photo/quality-check');
  assert.ok(qualityCheck.includes(aiLimiter), 'POST /me/photo/quality-check must include aiLimiter in its middleware chain');
  const aboutYou = middlewareNamesFor(users, 'get', '/me/about-you');
  assert.ok(aboutYou.includes(aiLimiter), 'GET /me/about-you must include aiLimiter in its middleware chain');
});
