// Tests for deep-matching #5 text-insight. The DB/network are injected, so the
// consent gate, strict-JSON rejection, and derived-only persistence are testable
// without `pg` or an API key. node --test.
const test = require('node:test');
const assert = require('node:assert');
const {
  validateExtraction, buildPrompt, sourceHash, extractForUser, CONSTRUCT_KEYS,
} = require('./textInsight');

// A well-formed LLM payload: every construct with a value in [0,1] + rationale.
function goodPayload() {
  const o = {};
  for (const k of CONSTRUCT_KEYS) o[k] = { value: 0.5, rationale: 'reads neutral from the text' };
  return o;
}

test('validateExtraction accepts a complete, in-range payload', () => {
  const r = validateExtraction(goodPayload());
  assert.ok(r);
  assert.deepEqual(Object.keys(r.vector).sort(), [...CONSTRUCT_KEYS].sort());
  assert.equal(r.vector[CONSTRUCT_KEYS[0]], 0.5);
  assert.equal(typeof r.rationales[CONSTRUCT_KEYS[0]], 'string');
});

test('validateExtraction parses a JSON STRING too', () => {
  assert.ok(validateExtraction(JSON.stringify(goodPayload())));
});

test('validateExtraction rejects malformed / hallucinated output (strict)', () => {
  assert.equal(validateExtraction('not json at all'), null);
  assert.equal(validateExtraction(null), null);
  assert.equal(validateExtraction({}), null);                        // missing all constructs
  const missing = goodPayload(); delete missing[CONSTRUCT_KEYS[0]];
  assert.equal(validateExtraction(missing), null);                   // missing one construct
  const oor = goodPayload(); oor[CONSTRUCT_KEYS[0]] = { value: 1.5, rationale: 'x' };
  assert.equal(validateExtraction(oor), null);                       // value out of [0,1]
  const noRat = goodPayload(); noRat[CONSTRUCT_KEYS[0]] = { value: 0.4, rationale: '' };
  assert.equal(validateExtraction(noRat), null);                     // empty rationale
  const badType = goodPayload(); badType[CONSTRUCT_KEYS[0]] = { value: 'high', rationale: 'x' };
  assert.equal(validateExtraction(badType), null);                   // non-numeric value
});

test('CONSENT GATE: no textInsight consent → no extraction, vector purged', async () => {
  let llmCalled = false, persisted = false, purged = false;
  const status = await extractForUser('u1', {
    consent: async () => false,
    gather: async () => 'plenty of bio text here',
    currentHash: async () => null,
    llm: async () => { llmCalled = true; return JSON.stringify(goodPayload()); },
    persist: async () => { persisted = true; },
    purge: async () => { purged = true; },
  });
  assert.equal(status, 'no-consent');
  assert.equal(llmCalled, false, 'LLM must never be called without consent');
  assert.equal(persisted, false, 'nothing persisted without consent');
  assert.equal(purged, true, 'any prior vector is purged');
});

test('STRICT-JSON: malformed LLM output is rejected and nothing is persisted', async () => {
  let persisted = false;
  const status = await extractForUser('u2', {
    consent: async () => true,
    gather: async () => 'I keep my room spotless and say what I mean.',
    currentHash: async () => null,
    llm: async () => '{"directness": "very"}',           // malformed
    persist: async () => { persisted = true; },
    purge: async () => {},
  });
  assert.equal(status, 'llm-rejected');
  assert.equal(persisted, false);
});

test('DERIVED-ONLY: persistence receives numbers + rationales, never the raw text', async () => {
  const sourceText = 'I am extremely tidy and direct. Secret detail: I live at 123 Main St.';
  let captured = null;
  const status = await extractForUser('u3', {
    consent: async () => true,
    gather: async () => sourceText,
    currentHash: async () => null,
    llm: async () => JSON.stringify(goodPayload()),
    persist: async (userId, vector, rationales, hash) => { captured = { userId, vector, rationales, hash }; },
    purge: async () => {},
  });
  assert.equal(status, 'extracted');
  assert.ok(captured, 'persist was called');
  // The persisted payload is exactly the numeric vector + rationales + a hash.
  assert.deepEqual(Object.keys(captured.vector).sort(), [...CONSTRUCT_KEYS].sort());
  // The raw text (and its distinctive PII) must appear NOWHERE in what we store.
  const blob = JSON.stringify({ v: captured.vector, r: captured.rationales, h: captured.hash });
  assert.ok(!blob.includes('123 Main St'), 'raw text / PII must never be stored');
  assert.equal(captured.hash, sourceHash(sourceText), 'only a hash of the text is kept');
});

test('unchanged text is skipped (no re-extraction)', async () => {
  const text = 'same text as before';
  let llmCalled = false;
  const status = await extractForUser('u4', {
    consent: async () => true,
    gather: async () => text,
    currentHash: async () => sourceHash(text),   // identical to what we'd compute
    llm: async () => { llmCalled = true; return JSON.stringify(goodPayload()); },
    persist: async () => {},
    purge: async () => {},
  });
  assert.equal(status, 'unchanged');
  assert.equal(llmCalled, false);
});

test('buildPrompt forbids sensitive inference and asks for strict JSON', () => {
  const p = buildPrompt('hello');
  assert.ok(/STRICT JSON/.test(p));
  assert.ok(/NEVER infer or mention mental health|protected\/sensitive/i.test(p));
});
