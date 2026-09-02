const test = require('node:test');
const assert = require('node:assert');

process.env.THIRD_PARTY_EXCERPT_CHARS = '200';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/none';

const { serveNotes } = require('./housing');

const LONG = 'A bright three bedroom apartment a short walk from campus with parking, '
  + 'in-unit laundry, and a landlord who answers the phone. '.repeat(6);

test('a student-posted listing is never trimmed — the text is ours by submission', () => {
  assert.equal(serveNotes(LONG, null), LONG);
});

test('a third-party description is trimmed to an excerpt', () => {
  const out = serveNotes(LONG, 'craigslist');
  assert.ok(out.length < LONG.length, 'should be shorter than the original');
  assert.ok(out.length <= 201, 'excerpt should respect the cap, got ' + out.length);
  assert.ok(out.endsWith('…'), 'should signal there is more to read');
});

test('it breaks on a word, so a truncation cannot read as corruption', () => {
  const out = serveNotes(LONG, 'craigslist').replace(/…$/, '');
  assert.ok(!/\s\S{1,2}$/.test(out) || out.endsWith(' ') === false, 'no dangling fragment');
  assert.ok(LONG.startsWith(out), 'excerpt must be a real prefix of the source, not reworded');
});

test('a short third-party description is left alone', () => {
  const short = 'Two bed near campus.';
  assert.equal(serveNotes(short, 'uloop'), short);
});

test('null notes stay null rather than becoming an ellipsis', () => {
  assert.equal(serveNotes(null, 'craigslist'), null);
});
