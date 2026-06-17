// Tests for the no-dashes house style. The founder wants ZERO dashes used as
// punctuation in any user-facing AI prose. stripDashes() is the server-side
// guarantee; these pin its behavior so a regex tweak can't regress it. `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const { stripDashes, stripDashesDeep } = require('./textStyle');

test('replaces a spaced em-dash with a comma', () => {
  assert.equal(stripDashes('you are warm and open — people relax around you'),
    'you are warm and open, people relax around you');
});

test('replaces an unspaced em-dash', () => {
  assert.equal(stripDashes('calm under pressure—steady when it counts'),
    'calm under pressure, steady when it counts');
});

test('replaces an en-dash used as punctuation', () => {
  assert.equal(stripDashes('direct – but never harsh'), 'direct, but never harsh');
});

test('replaces a spaced hyphen used as a dash', () => {
  assert.equal(stripDashes('you lead with curiosity - it shows'),
    'you lead with curiosity, it shows');
});

test('LEAVES hyphens inside compound words alone', () => {
  assert.equal(stripDashes('great at move-in coordination and well-being check-ins'),
    'great at move-in coordination and well-being check-ins');
});

test('does not leave a comma stranded before a period', () => {
  assert.equal(stripDashes('you value honesty — always.'), 'you value honesty, always.');
  // dash right before end-of-sentence should not produce ", ."
  assert.ok(!/,\s*\./.test(stripDashes('quiet, thoughtful — .')));
});

test('handles multiple dashes in one paragraph', () => {
  const out = stripDashes('you are social — energized by people — and warm.');
  assert.ok(!/[—–]/.test(out));
  assert.equal(out, 'you are social, energized by people, and warm.');
});

test('passes through non-strings untouched', () => {
  assert.equal(stripDashes(42), 42);
  assert.equal(stripDashes(null), null);
});

test('stripDashesDeep cleans nested object + array strings', () => {
  const input = {
    body: 'open — curious',
    sections: ['you repair fast — by morning', 'no dash here'],
    n: 3,
  };
  const out = stripDashesDeep(input);
  assert.equal(out.body, 'open, curious');
  assert.equal(out.sections[0], 'you repair fast, by morning');
  assert.equal(out.sections[1], 'no dash here');
  assert.equal(out.n, 3);
});
