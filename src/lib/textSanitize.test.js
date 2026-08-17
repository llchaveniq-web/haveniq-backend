// sanitizeNoteText — shared by matchOutcomes.js and pulses.js. Pure unit
// tests against the real contentFilter (no stubbing). node --test.
const test = require('node:test');
const assert = require('node:assert');
const { sanitizeNoteText } = require('./textSanitize');

test('non-string / empty / whitespace-only input returns null', () => {
  assert.equal(sanitizeNoteText(undefined), null);
  assert.equal(sanitizeNoteText(null), null);
  assert.equal(sanitizeNoteText(42), null);
  assert.equal(sanitizeNoteText('   '), null);
  assert.equal(sanitizeNoteText(''), null);
});

test('trims surrounding whitespace', () => {
  assert.equal(sanitizeNoteText('  hello there  '), 'hello there');
});

test('caps length at 2000 chars', () => {
  const out = sanitizeNoteText('x'.repeat(5000));
  assert.equal(out.length, 2000);
});

test('redacts an email address', () => {
  assert.equal(sanitizeNoteText('reach me at jordan.k+school@umich.edu please'), 'reach me at [redacted] please');
});

test('redacts a phone number', () => {
  // A leading "(" isn't consumed by the digit-anchored regex — pre-existing
  // behavior inherited verbatim from matchOutcomes.js, not something this
  // extraction changed. The digits themselves are gone either way.
  assert.equal(sanitizeNoteText('call (555) 867-5309 tonight'), 'call ([redacted] tonight');
  assert.equal(sanitizeNoteText('call 555-867-5309 tonight'), 'call [redacted] tonight');
});

test('redacts a social handle', () => {
  assert.equal(sanitizeNoteText('hit me up @jordan_k later'), 'hit me up [redacted] later');
});

test('redacts all three kinds in one note', () => {
  const out = sanitizeNoteText('email a@b.com, call 555-123-4567, or @handle me');
  assert.doesNotMatch(out, /a@b\.com/);
  assert.doesNotMatch(out, /555-123-4567/);
  assert.doesNotMatch(out, /@handle/);
});

test('a slur/threat is replaced with the safety-filter placeholder, not stored raw', () => {
  assert.equal(sanitizeNoteText('i will kill you if you do that again'), '[removed by safety filter]');
});

test('a scam-signal (FLAG-tier) note is NOT replaced — only BLOCK-tier content is', () => {
  const out = sanitizeNoteText('landlord wants the deposit in bitcoin, is that normal?');
  assert.notEqual(out, '[removed by safety filter]');
  assert.match(out, /bitcoin/);
});

test('ordinary benign text passes through untouched (after trim/redaction)', () => {
  assert.equal(sanitizeNoteText('things have been going well lately'), 'things have been going well lately');
});
