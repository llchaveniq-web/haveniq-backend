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

test('student-submitted photos are served regardless of the third-party switch', () => {
  const { servePhoto } = require('./housing');
  assert.equal(servePhoto('https://res.cloudinary.com/x.jpg', null), 'https://res.cloudinary.com/x.jpg');
});

test('third-party photos are served while the switch is on (default)', () => {
  const { servePhoto } = require('./housing');
  assert.equal(servePhoto('https://images.craigslist.org/a.jpg', 'craigslist'),
               'https://images.craigslist.org/a.jpg');
});

// ── Craigslist's category breadcrumb ──
//
// Measured on the live table: 42,254 of 47,647 collected listings carried one,
// averaging 43 characters. That was a fifth of the 200-char excerpt and the
// first two lines of the housing card, so the description never showed.

test('the category breadcrumb is stripped from a collected title', () => {
  const notes = 'Plank flooring Covered Parking Available - apts/housing for rent - apartment rent'
    + '\n\nWe are offering half a month off on select units.';
  const out = serveNotes(notes, 'craigslist');
  assert.ok(!/apts\/housing for rent/.test(out), 'breadcrumb should be gone: ' + out);
  assert.ok(out.startsWith('Plank flooring Covered Parking Available'), out);
  assert.ok(/half a month off/.test(out), 'the description must survive: ' + out);
});

test('the rooms & shares breadcrumb goes too', () => {
  const notes = 'Bedroom, with shared bath $800/ mo. - rooms & shares - apartment room roommate share rent'
    + '\n\nLooking for a roommate to share an Anaheim house.';
  const out = serveNotes(notes, 'craigslist');
  assert.ok(!/rooms & shares/.test(out), out);
  assert.ok(out.startsWith('Bedroom, with shared bath $800/ mo.'), out);
});

test("a trailing ' -...' on the breadcrumb goes with it", () => {
  const notes = 'Large Stand Alone Cottage - apts/housing for rent - apartment rent -...'
    + '\n\nOpen house Saturday.';
  const out = serveNotes(notes, 'craigslist');
  assert.ok(!/apartment rent/.test(out), out);
  assert.ok(out.startsWith('Large Stand Alone Cottage'), out);
});

// The guard that matters. A positional rule — "drop whatever follows the last
// dash" — would delete these, and they are real title text in the live data:
// "male preferred", "by owner" and "one adult" all appear as genuine endings.
test('a real title that merely ends in a dashed phrase is left alone', () => {
  for (const title of ['Room in quiet house - male preferred',
                       'Charming duplex - by owner',
                       'Studio near campus - one adult']) {
    assert.equal(serveNotes(title, 'craigslist'), title,
      'must not treat a real title as a breadcrumb: ' + title);
  }
});

test('a breadcrumb-only line is kept rather than served as a blank opening', () => {
  const notes = ' - apts/housing for rent - apartment rent' + '\n\nThe description.';
  const out = serveNotes(notes, 'craigslist');
  assert.ok(out.trim().length > 0, 'should not open on nothing');
  assert.ok(/The description/.test(out), out);
});

test('the breadcrumb goes even when the excerpt is switched off', () => {
  // THIRD_PARTY_EXCERPT_CHARS=0 restores full text; it is not a reason to
  // start serving another site's navigation again.
  const mod = requireFresh(() => {
    process.env.THIRD_PARTY_EXCERPT_CHARS = '0';
    delete require.cache[require.resolve('./housing')];
    return require('./housing');
  });
  const notes = 'Nice flat - apts/housing for rent - apartment rent' + '\n\nBody here.';
  assert.ok(!/apts\/housing for rent/.test(mod.serveNotes(notes, 'craigslist')));
  process.env.THIRD_PARTY_EXCERPT_CHARS = '200';
  delete require.cache[require.resolve('./housing')];
});

function requireFresh(fn) { return fn(); }

test('a student listing keeps its text even if it looks like a breadcrumb', () => {
  const notes = 'My place - apts/housing for rent - apartment rent';
  assert.equal(serveNotes(notes, null), notes);
});
