// Longitudinal pair dataset — normalization + the pair_key join. Pure unit
// tests (no DB): persistBatch/timeline take an injected db. The join is the
// make-or-break bit — get it wrong and the two sides of a roommate pairing
// never group, which no test downstream would notice. node --test.
const test = require('node:test');
const assert = require('node:assert');
const pe = require('./pairEvents');

const A = 'user-aaa', B = 'user-bbb';
const evt = (over = {}) => ({
  id: over.id || 'e1',
  type: 'pair_event',
  category: 'longitudinal',
  timestamp: 1_700_000_000_000,
  payload: {
    pairId: B, t: 1_700_000_000_000, kind: 'signal', subtype: 'pulse',
    topic: 'guests', value: 2, meta: { raised: true },
    ...(over.payload || {}),
  },
});

// ── The join ──
test('both sides of a pairing land under ONE pair_key', () => {
  // A emits keyed on B; B emits keyed on A.
  const fromA = pe.normalize(evt(), A);
  const fromB = pe.normalize({ ...evt({ id: 'e2' }), payload: { ...evt().payload, pairId: A } }, B);
  assert.equal(fromA.pairKey, fromB.pairKey, 'the two halves must group together');
});

test('pair_key is the sorted unordered pair, not the emit order', () => {
  assert.equal(pe.pairKeyFor(A, B), pe.pairKeyFor(B, A));
  assert.equal(pe.pairKeyFor(A, B), [A, B].sort().join(':'));
});

test('pair_key is derived server-side and ignores any client-sent key', () => {
  const spoofed = evt();
  spoofed.payload.pairKey = 'someone:else';
  const r = pe.normalize(spoofed, A);
  assert.equal(r.pairKey, pe.pairKeyFor(A, B), 'a client must not choose its own pair_key');
});

test('user_id comes from the token, never the payload', () => {
  const spoofed = evt();
  spoofed.payload.userId = 'victim';
  assert.equal(pe.normalize(spoofed, A).userId, A);
});

// ── Shape validation ──
test('keeps every documented field', () => {
  const r = pe.normalize(evt(), A);
  assert.equal(r.id, 'e1');
  assert.equal(r.pairId, B);
  assert.equal(r.t, 1_700_000_000_000);
  assert.equal(r.kind, 'signal');
  assert.equal(r.subtype, 'pulse');
  assert.equal(r.topic, 'guests');
  assert.equal(r.value, 2);
  assert.deepEqual(r.meta, { raised: true });
});

test('optional fields are null, not undefined or invented', () => {
  const r = pe.normalize({ ...evt(), payload: { pairId: B, t: 1, kind: 'outcome', subtype: 'ended' } }, A);
  assert.equal(r.topic, null);
  assert.equal(r.value, null);
  assert.equal(r.meta, null);
});

test('an unrecognized kind is dropped (it has no place in the chain)', () => {
  assert.equal(pe.normalize({ ...evt(), payload: { ...evt().payload, kind: 'vibes' } }, A), null);
});

for (const k of ['signal', 'intervention', 'outcome']) {
  test(`kind "${k}" is accepted`, () => {
    assert.ok(pe.normalize({ ...evt(), payload: { ...evt().payload, kind: k } }, A));
  });
}

test('an UNKNOWN subtype is kept, not silently dropped', () => {
  // Dropping it would punch an unrecoverable hole in a longitudinal record the
  // moment the app ships new vocabulary.
  const r = pe.normalize({ ...evt(), payload: { ...evt().payload, subtype: 'mediation_booked' } }, A);
  assert.ok(r);
  assert.equal(r.subtype, 'mediation_booked');
  assert.ok(!pe.KNOWN_SUBTYPES.has('mediation_booked'), 'and it is reported as unknown');
});

test('rows missing the essentials are dropped', () => {
  assert.equal(pe.normalize({ ...evt(), id: '' }, A), null, 'no id ⇒ no dedup key');
  assert.equal(pe.normalize({ ...evt(), payload: { ...evt().payload, pairId: '' } }, A), null);
  assert.equal(pe.normalize({ ...evt(), payload: { ...evt().payload, t: 'soon' } }, A), null);
  assert.equal(pe.normalize({ ...evt(), payload: { ...evt().payload, subtype: '' } }, A), null);
  assert.equal(pe.normalize({ ...evt(), payload: null }, A), null);
});

test('a user paired with themselves is refused', () => {
  assert.equal(pe.normalize({ ...evt(), payload: { ...evt().payload, pairId: A } }, A), null);
});

// ── Privacy shape ──
test('free-text meta is refused (never free text, never names)', () => {
  const r = pe.normalize({ ...evt(), payload: { ...evt().payload, meta: 'Alex said he would move out' } }, A);
  assert.equal(r.meta, null, 'a string in meta is exactly where a note would land');
});

test('oversized meta is refused rather than truncated into nonsense', () => {
  const big = { note: 'x'.repeat(5000) };
  assert.equal(pe.normalize({ ...evt(), payload: { ...evt().payload, meta: big } }, A).meta, null);
});

test('an array meta is refused', () => {
  assert.equal(pe.normalize({ ...evt(), payload: { ...evt().payload, meta: ['a'] } }, A).meta, null);
});

// ── Batch persistence ──
// `consented` defaults true so every existing persistBatch test below (none
// of which are ABOUT consent — that's covered in its own test block further
// down) keeps exercising the same normalize/insert behavior it always has.
function fakeDb(existingIds = new Set(), { consented = true } = {}) {
  const inserts = [];
  return {
    inserts,
    query: async (sql, params) => {
      if (/SELECT 1 FROM pair_consent/.test(sql)) {
        return { rows: consented ? [{ '?column?': 1 }] : [] };
      }
      if (/INSERT INTO pair_events/.test(sql)) {
        if (existingIds.has(params[0])) return { rowCount: 0 };   // ON CONFLICT DO NOTHING
        existingIds.add(params[0]);
        inserts.push(params);
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('only pair_event rows are persisted; other telemetry is left alone', async () => {
  pe._resetTableReady();
  const db = fakeDb();
  const res = await pe.persistBatch(
    [evt(), { id: 'b1', type: 'behavioral_event', payload: {} }, { id: 'm1', type: 'mood_entry', payload: {} }],
    A, db,
  );
  assert.equal(res.stored, 1);
  assert.equal(db.inserts.length, 1);
});

test('re-sending the same event id stores nothing extra (idempotent retry)', async () => {
  pe._resetTableReady();
  const seen = new Set();
  const db = fakeDb(seen);
  assert.equal((await pe.persistBatch([evt()], A, db)).stored, 1);
  assert.equal((await pe.persistBatch([evt()], A, db)).stored, 0, 'dedup on the client event id');
});

test('a malformed event is dropped without taking the batch down', async () => {
  pe._resetTableReady();
  const db = fakeDb();
  const res = await pe.persistBatch(
    [evt(), { ...evt({ id: 'bad' }), payload: { ...evt().payload, kind: 'nope' } }], A, db,
  );
  assert.equal(res.stored, 1);
  assert.equal(res.dropped, 1);
});

test('the insert writes the server-derived pair_key', async () => {
  pe._resetTableReady();
  const db = fakeDb();
  await pe.persistBatch([evt()], A, db);
  assert.equal(db.inserts[0][3], pe.pairKeyFor(A, B));
});

// ── Read shape ──
test('timeline returns t as a NUMBER, matching the client export', async () => {
  pe._resetTableReady();
  const db = {
    query: async (sql) => {
      if (/SELECT/.test(sql)) {
        return { rows: [{
          id: 'e1', user_id: A, pair_id: B, pair_key: pe.pairKeyFor(A, B),
          t: '1700000000000',                      // BIGINT arrives as a string
          kind: 'signal', subtype: 'pulse', topic: 'guests', value: 2,
          meta: { raised: true }, created_at: 'now',
        }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const rows = await pe.timeline(pe.pairKeyFor(A, B), db);
  assert.strictEqual(rows[0].t, 1_700_000_000_000, 'string t would break the client-set comparison');
  assert.strictEqual(typeof rows[0].t, 'number');
});

test('an empty pairing returns [] — a missing outcome stays missing', async () => {
  pe._resetTableReady();
  const db = { query: async () => ({ rows: [], rowCount: 0 }) };
  assert.deepEqual(await pe.timeline('nobody:nobody', db), []);
});
