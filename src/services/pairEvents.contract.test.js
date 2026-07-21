// Lockstep guard: the exact envelope the APP emits must parse.
//
// Verified 2026-07-21 against the app (branch claude/quirky-mayer-3krjdo):
//   stores/pairLedgerStore.ts  -> telemetry.enqueue('pair_event', {
//                                   pairId, t, kind, subtype, topic?, value?, meta? })
//   services/telemetrySync.ts  -> wraps it as
//                                   { id, type, category, timestamp, payload }
//                                 with TYPE_TO_CATEGORY.pair_event = 'longitudinal'
//
// These fixtures are copied from that emitter, NOT from the spec prose — a
// backend that only ever parsed its own idea of the contract would silently
// store nothing and look identical to "no pairs yet". If the app changes the
// emitted shape, this fails instead of the dataset quietly staying empty.
// node --test.
const test = require('node:test');
const assert = require('node:assert');
const pe = require('./pairEvents');

const ME = 'user-me', THEM = 'user-them';

// Envelope exactly as telemetrySync.enqueue builds it.
const wrap = (payload) => ({
  id: 'evt_abc123',
  type: 'pair_event',
  category: 'longitudinal',
  timestamp: 1_700_000_000_000,
  payload,
});

test('a pulse signal from the real emitter parses', () => {
  // recordPairEvent omits topic/value/meta entirely when undefined (spread
  // guards), so the parser must cope with genuinely absent keys — not nulls.
  const r = pe.normalize(wrap({
    pairId: THEM, t: 1_700_000_000_000, kind: 'signal', subtype: 'pulse',
    topic: 'guests', value: 2,
  }), ME);
  assert.ok(r);
  assert.equal(r.kind, 'signal');
  assert.equal(r.value, 2);
  assert.equal(r.meta, null, 'absent meta ⇒ null, not undefined');
});

test('a minimal event with every optional key ABSENT parses', () => {
  const r = pe.normalize(wrap({
    pairId: THEM, t: 1_700_000_000_000, kind: 'outcome', subtype: 'moved_in',
  }), ME);
  assert.ok(r, 'the emitter omits optional keys rather than sending null');
  assert.equal(r.topic, null);
  assert.equal(r.value, null);
});

test('value 0 survives (a pulse level of 0 is data, not absence)', () => {
  const r = pe.normalize(wrap({
    pairId: THEM, t: 1, kind: 'signal', subtype: 'pulse', topic: 'noise', value: 0,
  }), ME);
  assert.strictEqual(r.value, 0, '0 must not be coerced to null by a falsy check');
});

test('the documented meta shapes all round-trip', () => {
  for (const meta of [{ raised: true }, { outcome: 'resolved' }, { warningKind: 'strain', severity: 2 }]) {
    const r = pe.normalize(wrap({
      pairId: THEM, t: 1, kind: 'intervention', subtype: 'early_warning_fired', meta,
    }), ME);
    assert.deepEqual(r.meta, meta);
  }
});

test('every subtype the app ships today is accepted', () => {
  const shipped = ['pulse', 'early_warning_fired', 'nudge_shown', 'repair_completed',
                   'agreement_made', 'checkin', 'moved_in', 'ended'];
  for (const subtype of shipped) {
    const r = pe.normalize(wrap({ pairId: THEM, t: 1, kind: 'signal', subtype }), ME);
    assert.ok(r, `app subtype "${subtype}" must parse`);
    assert.ok(pe.KNOWN_SUBTYPES.has(subtype), `and be known, so it isn't flagged as drift`);
  }
});

test('a check-in rating (1-5) parses on the documented kind', () => {
  const r = pe.normalize(wrap({
    pairId: THEM, t: 1, kind: 'outcome', subtype: 'checkin', value: 4,
  }), ME);
  assert.equal(r.value, 4);
});
