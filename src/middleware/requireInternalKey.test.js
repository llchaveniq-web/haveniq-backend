// The single guard for internal / server-to-server endpoints.
//
// These routes have NO user auth — the secret header IS the authentication —
// so this is the whole boundary for cron triggers, the signup auto-review bot,
// match recompute and the weight analyst. node --test.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { requireInternalKey, hasValidInternalKey, constantTimeEqual } = require('./requireInternalKey');

const KEY = 'internal-key-0123456789';
const BOT = 'legacy-bot-token-abcdef';

// MUST await fn() before restoring: the earlier synchronous version handed the
// promise back and restored the env immediately, so every async assertion ran
// with the secrets already unset and saw a 503. The failures that produced were
// in this harness, not in the middleware.
const withEnv = async (vars, fn) => {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
};

// Run the middleware and capture what it did.
const run = (headers) => new Promise((resolve) => {
  const req = { headers, get: (h) => headers[String(h).toLowerCase()] };
  const res = {
    status(c) { this.code = c; return this; },
    json(b) { resolve({ code: this.code, body: b }); },
  };
  requireInternalKey(req, res, () => resolve({ code: 200, body: 'NEXT' }));
});

// ── The boundary ──
test('no key ⇒ 401', async () => {
  await withEnv({ INTERNAL_API_KEY: KEY, ADMIN_BOT_TOKEN: undefined }, async () => {
    assert.equal((await run({})).code, 401);
  });
});

test('wrong key ⇒ 401', async () => {
  await withEnv({ INTERNAL_API_KEY: KEY, ADMIN_BOT_TOKEN: undefined }, async () => {
    assert.equal((await run({ 'x-internal-key': 'nope' })).code, 401);
    assert.equal((await run({ 'x-internal-key': KEY + 'x' })).code, 401, 'a prefix must not pass');
    assert.equal((await run({ 'x-internal-key': KEY.slice(0, -1) })).code, 401);
  });
});

test('correct X-Internal-Key ⇒ passes', async () => {
  await withEnv({ INTERNAL_API_KEY: KEY, ADMIN_BOT_TOKEN: undefined }, async () => {
    assert.equal((await run({ 'x-internal-key': KEY })).code, 200);
  });
});

test('legacy Authorization: Bearer <ADMIN_BOT_TOKEN> still passes', async () => {
  // The live cron jobs and the Discord bot authenticate this way. Dropping it
  // in the same change would take them down silently.
  await withEnv({ INTERNAL_API_KEY: undefined, ADMIN_BOT_TOKEN: BOT }, async () => {
    assert.equal((await run({ authorization: `Bearer ${BOT}` })).code, 200);
    assert.equal((await run({ authorization: `Bearer wrong` })).code, 401);
    assert.equal((await run({ authorization: BOT })).code, 401, 'must be a Bearer token, not a bare value');
  });
});

test('either credential works when both are configured', async () => {
  await withEnv({ INTERNAL_API_KEY: KEY, ADMIN_BOT_TOKEN: BOT }, async () => {
    assert.equal((await run({ 'x-internal-key': KEY })).code, 200);
    assert.equal((await run({ authorization: `Bearer ${BOT}` })).code, 200);
    // A wrong X-Internal-Key must not shadow a valid bearer.
    assert.equal((await run({ 'x-internal-key': 'wrong', authorization: `Bearer ${BOT}` })).code, 200);
  });
});

test('NO secret configured ⇒ 503, never open', async () => {
  await withEnv({ INTERNAL_API_KEY: undefined, ADMIN_BOT_TOKEN: undefined }, async () => {
    const res = await run({ 'x-internal-key': 'anything' });
    assert.equal(res.code, 503, 'a deploy that loses the env var must LOCK, not expose');
  });
});

test('an empty-string secret does not become a valid key', async () => {
  await withEnv({ INTERNAL_API_KEY: '', ADMIN_BOT_TOKEN: undefined }, async () => {
    assert.equal((await run({ 'x-internal-key': '' })).code, 503);
  });
});

// ── Constant-time compare (the regression this whole change exists for) ──
test('constantTimeEqual rejects length mismatch and non-strings safely', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('', ''), false);
  assert.equal(constantTimeEqual(null, 'abc'), false);
  assert.equal(constantTimeEqual(undefined, undefined), false);
  assert.equal(constantTimeEqual({}, 'abc'), false);
});

// ── The drift guard ──
// Four route files compared the secret with `got !== tok` because the module
// they imported did not exist, so they silently used a weak inline fallback.
// This fails if a plain-comparison copy is reintroduced anywhere.
test('no route file compares an internal secret with a plain === / !==', () => {
  // Scans a WINDOW after the secret is read, not just the same line. The real
  // weak copies looked like:
  //     const tok = process.env.ADMIN_BOT_TOKEN;   // <- names the secret
  //     ...
  //     if (got !== tok) return res.status(401)    // <- the weak compare
  // so a same-line check (the first version of this test) passed while four
  // files were still comparing in variable time.
  const dir = path.join(__dirname, '..', 'routes');
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && !x.includes('.test.'))) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*process\.env\.(ADMIN_BOT_TOKEN|INTERNAL_API_KEY)/);
      if (!m) return;
      const varName = m[1];
      for (const next of lines.slice(i + 1, i + 12)) {
        if (new RegExp(`[!=]==\\s*${varName}\\b|\\b${varName}\\s*[!=]==`).test(next)) {
          offenders.push(`${f}:${i + 1} → ${next.trim().slice(0, 80)}`);
        }
      }
    });
  }
  assert.deepEqual(offenders, [], 'compare internal secrets via middleware/requireInternalKey, not ===');
});

test('the module the route files import actually exists', () => {
  // routes/{housing,matchOutcomes,profile,weightLearning}.js do
  // `try { require('../middleware/botAuth') } catch { <weak fallback> }`.
  // If this file goes missing again, all four silently downgrade.
  const botAuth = require('./botAuth');
  assert.equal(typeof botAuth.requireBotToken, 'function');
  assert.equal(botAuth.requireBotToken, requireInternalKey, 'must be the SAME implementation, not a copy');
});

// ── The secret must never reach a client ──
test('INTERNAL_API_KEY is never echoed into a response body', () => {
  const roots = [path.join(__dirname, '..', 'routes'), path.join(__dirname, '..', 'services')];
  const bad = [];
  for (const dir of roots) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && !x.includes('.test.'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      // A res.json / res.send carrying the secret on the same line.
      for (const line of src.split('\n')) {
        if (/res\.(json|send)/.test(line) && /INTERNAL_API_KEY|ADMIN_BOT_TOKEN/.test(line)) {
          bad.push(`${f}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
  }
  assert.deepEqual(bad, [], 'internal secrets must never be serialized to a client');
});
