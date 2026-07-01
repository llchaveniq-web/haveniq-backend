// Pure guardrail tests: the volume circuit breaker + priority dedup. No DB.
const test = require('node:test');
const assert = require('node:assert');
const { circuitBreaker, dedupByPriority } = require('./lifecycleSegments');

test('circuitBreaker: within the fraction → no trip', () => {
  const b = circuitBreaker(5, 100, 0.10, 0);   // cap = 10
  assert.equal(b.trip, false);
  assert.equal(b.threshold, 10);
});

test('circuitBreaker: over the fraction → trip (blast guard)', () => {
  const b = circuitBreaker(40, 100, 0.10, 0);  // cap = 10, planned 40
  assert.equal(b.trip, true);
  assert.equal(b.threshold, 10);
});

test('circuitBreaker: minAbs allows a small launch batch through', () => {
  // active tiny → fraction cap is 0, but minAbs=10 lets a small batch send.
  const b = circuitBreaker(8, 5, 0.10, 10);
  assert.equal(b.threshold, 10);
  assert.equal(b.trip, false);
  // above minAbs with tiny active → trip
  assert.equal(circuitBreaker(11, 5, 0.10, 10).trip, true);
});

test('circuitBreaker: minAbs=0 enforces a pure fraction', () => {
  assert.equal(circuitBreaker(1, 5, 0.10, 0).trip, true);   // cap floor(0.5)=0
  assert.equal(circuitBreaker(0, 5, 0.10, 0).trip, false);
});

test('dedupByPriority: a user in multiple segments is sent ONE nudge (highest priority)', () => {
  const bySegment = [
    { segmentId: 'quiz_incomplete', templateId: 'q_v1', recipients: [{ id: 'u1', email: 'a@x.edu', first_name: 'A' }, { id: 'u2', email: 'b@x.edu', first_name: 'B' }] },
    { segmentId: 'matches_waiting', templateId: 'm_v1', recipients: [{ id: 'u1', email: 'a@x.edu', first_name: 'A' }, { id: 'u3', email: 'c@x.edu', first_name: 'C' }] },
    { segmentId: 'invited_nobody',  templateId: 'i_v1', recipients: [{ id: 'u2', email: 'b@x.edu', first_name: 'B' }] },
  ];
  const out = dedupByPriority(bySegment);
  assert.equal(out.length, 3);                                   // u1, u2, u3 — once each
  assert.equal(out.find((r) => r.userId === 'u1').segmentId, 'quiz_incomplete'); // highest priority wins
  assert.equal(out.find((r) => r.userId === 'u2').segmentId, 'quiz_incomplete');
  assert.equal(out.find((r) => r.userId === 'u3').segmentId, 'matches_waiting');
});

test('dedupByPriority: skips rows without an id', () => {
  const out = dedupByPriority([{ segmentId: 's', templateId: 't', recipients: [{ email: 'x' }, null] }]);
  assert.deepEqual(out, []);
});
