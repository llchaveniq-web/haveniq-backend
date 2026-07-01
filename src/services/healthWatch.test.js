// Tests for the Watch-loop core: classification + the debounced transition
// state machine. Pure — no network, no timers. node --test.
const test = require('node:test');
const assert = require('node:assert');
const { classify, createWatcher } = require('./healthWatch');

const OK   = { httpStatus: 200, body: { db: 'up', commit: 'abc1234' }, latencyMs: 5 };
const DOWN = { httpStatus: 503, body: { db: 'down', commit: 'abc1234' }, latencyMs: 5 };

// ── classify ────────────────────────────────────────────────────────────────
test('classify: 200 + db up → healthy, no reasons', () => {
  const c = classify(OK);
  assert.equal(c.healthy, true);
  assert.deepEqual(c.reasons, []);
  assert.equal(c.sha, 'abc1234');
});

test('classify: 503 + db down → unhealthy with reasons', () => {
  const c = classify(DOWN);
  assert.equal(c.healthy, false);
  assert.ok(c.reasons.includes('http_503'));
  assert.ok(c.reasons.includes('db_down'));
});

test('classify: unreachable (fetch failed) → unhealthy', () => {
  const c = classify({ httpStatus: null, body: null, latencyMs: 4000, error: 'TimeoutError' });
  assert.equal(c.healthy, false);
  assert.ok(c.reasons.some((r) => r.startsWith('unreachable')));
  assert.ok(c.reasons.includes('db_unknown'));
});

test('classify: SHA mismatch only counts when an expected SHA is set', () => {
  const raw = { httpStatus: 200, body: { db: 'up', commit: 'newsha' }, latencyMs: 5 };
  assert.equal(classify(raw).healthy, true);                 // no expected → informational
  const c = classify(raw, 'oldsha');
  assert.equal(c.healthy, false);                            // expected set + differs → unhealthy
  assert.ok(c.reasons.some((r) => r.startsWith('sha_mismatch')));
});

// ── observe: debounce + single-fire transitions ─────────────────────────────
function mkWatcher() {
  const fires = [], clears = [];
  const w = createWatcher({
    failThreshold: 3, recoverThreshold: 2, capacity: 10,
    onFire: (r, m) => fires.push(m.consecutiveFail),
    onClear: (r, m) => clears.push(m.consecutiveOk),
  });
  return { w, fires, clears };
}

test('observe: a single blip does NOT page (below the threshold)', () => {
  const { w, fires } = mkWatcher();
  w.observe(classify(OK));
  w.observe(classify(DOWN));      // 1 fail
  w.observe(classify(OK));        // recovered before threshold
  assert.equal(fires.length, 0);
  assert.equal(w.status().alertActive, false);
});

test('observe: fires ONCE at the fail threshold, not again while down', () => {
  const { w, fires } = mkWatcher();
  assert.equal(w.observe(classify(DOWN)), null);   // 1
  assert.equal(w.observe(classify(DOWN)), null);   // 2
  assert.equal(w.observe(classify(DOWN)), 'fire');  // 3 → page
  assert.equal(w.observe(classify(DOWN)), null);   // 4 → already active, no re-page
  assert.equal(fires.length, 1);
  assert.equal(w.status().state, 'unhealthy');
  assert.equal(w.status().alertActive, true);
});

test('observe: clears ONCE at the recover threshold', () => {
  const { w, fires, clears } = mkWatcher();
  w.observe(classify(DOWN)); w.observe(classify(DOWN)); w.observe(classify(DOWN)); // fire
  assert.equal(w.observe(classify(OK)), null);      // 1 ok — not yet
  assert.equal(w.observe(classify(OK)), 'clear');   // 2 ok — all-clear
  assert.equal(w.observe(classify(OK)), null);      // stays cleared
  assert.equal(fires.length, 1);
  assert.equal(clears.length, 1);
  assert.equal(w.status().alertActive, false);
  assert.equal(w.status().state, 'healthy');
});

// ── history + status honesty ────────────────────────────────────────────────
test('status: unknown with 0 observations (never a fake all-green)', () => {
  const { w } = mkWatcher();
  const s = w.status();
  assert.equal(s.state, 'unknown');
  assert.equal(s.observations, 0);
  assert.equal(s.lastChecked, null);
  assert.deepEqual(w.history(), []);
});

test('history: most-recent-first and capped at capacity', () => {
  const { w } = mkWatcher(); // capacity 10
  for (let i = 0; i < 15; i++) w.observe(classify(OK), `t${i}`);
  const h = w.history();
  assert.equal(h.length, 10);              // ring capped
  assert.equal(h[0].timestamp, 't14');     // newest first
  assert.equal(h[9].timestamp, 't5');      // oldest kept
});
