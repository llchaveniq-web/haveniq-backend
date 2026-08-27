// Craigslist adapter — sitemap selection and posting extraction.
//
// Every fixture below is the real markup Craigslist served to HavenIQBot on
// 2026-08-26, trimmed to the elements under test. Fabricated fixtures are
// worse than no tests for a parser: they encode what you ASSUMED the site
// returns, and then pass forever while the parser fails on the real thing.
//
// node --test.
const test = require('node:test');
const assert = require('node:assert');
const cl = require('./craigslist');

// ── sitemap selection ──────────────────────────────────────────────────────

const INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://www.craigslist.org/sitemap-postings-2026-08-25-lax-hhh.xml</loc></sitemap>
  <sitemap><loc>https://www.craigslist.org/sitemap-postings-2026-08-26-lax-hhh.xml</loc></sitemap>
  <sitemap><loc>https://www.craigslist.org/sitemap-postings-2026-08-26-lax-sss.xml</loc></sitemap>
  <sitemap><loc>https://www.craigslist.org/sitemap-postings-2026-08-26-sfo-hhh.xml</loc></sitemap>
</sitemapindex>`;

test('picks only housing sitemaps for the requested region', () => {
  const got = cl.housingSitemapsFor(INDEX, 'lax');
  assert.equal(got.length, 2, 'two dates of LA housing, and nothing else');
  assert.ok(got.every(u => u.includes('-lax-hhh.xml')));
  assert.ok(!got.some(u => u.includes('sss')), 'for-sale is not housing');
  assert.ok(!got.some(u => u.includes('sfo')), 'another region is not ours');
});

test('newest sitemap first, so a capped run gets the freshest postings', () => {
  const got = cl.housingSitemapsFor(INDEX, 'lax');
  assert.ok(got[0].includes('2026-08-26'));
});

test('an unknown region yields nothing rather than everything', () => {
  // A typo'd region must not silently fall back to crawling the whole index.
  assert.deepEqual(cl.housingSitemapsFor(INDEX, 'nope'), []);
});

// ── field extraction, from the real posting ────────────────────────────────

const REAL = `
<meta property="og:title" content="&#8206;Ideally located just steps from the sand on the Balboa Peninsula, this inviti - apts/housing for rent - apartment...">
<span class="price">$1,200</span>
<div class="attrgroup"><span class="attr important">0BR / 1Ba 569ft<sup>2</sup> available now</span></div>
<div class="attr rent_period">rent period: <b>monthly</b></div>
<div class="attr pets_cat">cats are OK - purrr</div>
<div class="attr airconditioning">air conditioning</div>
<div class="mapbox" data-latitude="34.096900" data-longitude="-118.328000"></div>
<time datetime="2026-08-26T12:09:43-0700">26 Aug</time>
<section id="postingbody">QR Code Link to This Post Ideally located just steps from the sand.</section>`;

test('extracts the fields HavenIQ stores', () => {
  const p = cl.parsePosting(REAL, 'https://www.craigslist.org/view/d/x/abc');
  assert.equal(p.totalRentCents, 120000, 'dollars to cents');
  assert.equal(p.latitude, 34.0969);
  assert.equal(p.longitude, -118.328);
  assert.equal(p.postedAt, '2026-08-26T12:09:43-0700');
  assert.equal(p.sourceUrl, 'https://www.craigslist.org/view/d/x/abc');
});

test('a studio becomes 1 bed and is flagged, not dropped', () => {
  // listings.beds CHECKs BETWEEN 1 AND 10, so 0BR cannot be stored literally.
  // Studios are most of the cheap supply near a campus; losing them all would
  // be a far bigger distortion than recording one as a single bedroom.
  const p = cl.parsePosting(REAL, 'u');
  assert.equal(p.beds, 1);
  assert.equal(p.baths, 1);
  assert.equal(p.isStudio, true);
});

test('strips the category boilerplate Craigslist appends to its own titles', () => {
  const p = cl.parsePosting(REAL, 'u');
  assert.ok(!/apts\/housing/i.test(p.title), 'category suffix gone');
  assert.ok(!/craigslist/i.test(p.title));
  assert.ok(p.title.startsWith('Ideally located'));
});

test('removes the invisible direction mark from the title', () => {
  // Craigslist prepends U+200E to some titles. It survives into the stored
  // value and into any search over it, while being impossible to see.
  const p = cl.parsePosting(REAL, 'u');
  assert.ok(!/[‎‏‪-‮﻿]/.test(p.title));
});

test('keeps a real title that merely contains a dash', () => {
  // The reason boilerplate is stripped segment-by-segment rather than by
  // cutting at the last dash: here the useful half is AFTER it.
  assert.equal(
    cl.cleanTitle('2BR in Westwood - available Sept 1 - apts/housing for rent - craigslist'),
    '2BR in Westwood - available Sept 1',
  );
});

test('carries the attribute chips into notes, where the scam scorer reads them', () => {
  const p = cl.parsePosting(REAL, 'u');
  assert.ok(p.attrs.includes('air conditioning'));
  assert.ok(p.notes.includes('air conditioning'));
  assert.ok(!/QR Code Link/i.test(p.notes), 'the print QR boilerplate is dropped');
});

// ── refusing to guess ──────────────────────────────────────────────────────

test('a posting with no price is skipped, not stored at zero', () => {
  const p = cl.parsePosting(REAL.replace('<span class="price">$1,200</span>', ''), 'u');
  assert.equal(p, null);
});

test('a posting with no coordinates is skipped', () => {
  // Without a location a student cannot act on it, and inventing one is worse
  // than not having the listing.
  const p = cl.parsePosting(REAL.replace(/data-latitude="[^"]*" data-longitude="[^"]*"/, ''), 'u');
  assert.equal(p, null);
});

test('out-of-range coordinates are rejected rather than stored', () => {
  const bad = REAL.replace('34.096900', '999').replace('-118.328000', '999');
  assert.equal(cl.parsePosting(bad, 'u'), null);
});

test('malformed input degrades to null instead of throwing', () => {
  for (const junk of ['', '<html></html>', null, undefined, '<span class="price">$abc</span>']) {
    assert.doesNotThrow(() => cl.parsePosting(junk, 'u'));
    assert.equal(cl.parsePosting(junk, 'u'), null);
  }
});

// ─── Per-person pricing, non-housing, and short stays ─────────────────────
//
// The first live run mispriced rooms, and the first attempt at fixing it
// over-matched on the posting BODY and would have deleted 22 real apartments
// and tripled the rent on a whole condo. Both directions are tested here: the
// thing the rule must catch, and the thing it must leave alone.

const ROOM = `
<meta property="og:title" content="Pvt room furnished Miracle Mile area - rooms &amp; shares - apartment room">
<span class="price">$650</span>
<div class="attrgroup"><span class="attr important">3BR / 2Ba</span></div>
<div class="mapbox" data-latitude="34.0620" data-longitude="-118.3560"></div>
<section id="postingbody">Private room for rent in a 3 bedroom apartment. Shared kitchen.</section>`;

test('a room is priced per person and is NOT divided by the bed count', () => {
  // The bug that shipped: $650 / 3BR = $216, which no room in Los Angeles
  // rents for. The apartment has three bedrooms; the tenant rents one.
  const p = cl.parsePosting(ROOM, 'u');
  assert.equal(p.totalRentCents, 65000);
  assert.equal(p.beds, 3);
  assert.equal(p.pricedPerPerson, true);
});

test('a whole apartment is still divided, because the total is the total', () => {
  // The fix must not overshoot: a 3BR let as one unit at $3,000 really is
  // $1,000 a head, and flattening that would break every ordinary listing.
  assert.equal(cl.parsePosting(REAL, 'u').pricedPerPerson, false);
});

test('a whole condo is not repriced because its body mentions a master bedroom', () => {
  // The real regression. A $6,450 3-bed Redondo Beach condo describes its own
  // master bedroom; reading the BODY tripled its per-person rent to $6,450.
  const condo = ROOM
    .replace('Pvt room furnished Miracle Mile area - rooms &amp; shares - apartment room',
             'South Redondo Beach 3 bed / 3.5 bath condo - apts/housing for rent - apartment')
    .replace('Private room for rent in a 3 bedroom apartment. Shared kitchen.',
             'Huge master bedroom with ensuite. Private room off the kitchen too.');
  assert.equal(cl.parsePosting(condo, 'u').pricedPerPerson, false);
});

test('room language is read from the title, where the subcategory is missing', () => {
  // Craigslist serves canonical /view/d/ URLs with no cat= breadcrumb, so a
  // null subcategory is the common case rather than the corner.
  assert.equal(cl.subcategory(ROOM), null);
  assert.equal(cl.pricedPerPerson(null, 'Master bedroom private entrance'), true);
  assert.equal(cl.pricedPerPerson(null, 'Roommates wanted for fall'), true);
  assert.equal(cl.pricedPerPerson('roo', 'anything at all'), true);
});

test('an ordinary apartment title is not mistaken for a room', () => {
  for (const t of ['2BR in Westwood available Sept 1', 'Spacious 1x1 with parking', 'Bright studio near campus']) {
    assert.equal(cl.pricedPerPerson(null, t), false, t);
  }
});

test('an office is not somewhere to live', () => {
  // Reached the queue on the first live run: "DTLA private office for rent".
  const office = ROOM.replace('Pvt room furnished Miracle Mile area', 'DTLA private office for lease');
  assert.equal(cl.parsePosting(office, 'u'), null);
});

test('an apartment offering a parking space is still an apartment', () => {
  // The other regression: matching the body threw out "BEAUTIFUL 1 BED/1 BATH",
  // "STUDIO IN GREAT AREA" and 20 more, because each mentioned parking.
  const withParking = REAL.replace('Ideally located just steps from the sand.',
    'Includes one assigned parking space and extra storage space in the garage.');
  assert.ok(cl.parsePosting(withParking, 'u'), 'a parking amenity is not a parking rental');
});

test('the posting\'s own rent-period field decides, not the prose', () => {
  const weekly = REAL.replace('rent period: <b>monthly</b>', 'rent period: <b>weekly</b>');
  assert.equal(cl.parsePosting(weekly, 'u'), null);
  assert.equal(cl.rentPeriod(['rent period: nightly', 'cats are OK']), 'nightly');
  assert.equal(cl.rentPeriod(['cats are OK']), null);
});

test('a monthly rate survives the word "weekly" appearing in the title', () => {
  // "Clean & Sober Hostel - Weekly & Monthly Rates" is a real monthly rental.
  // The declared period outranks the title whenever the posting states one.
  const hostel = REAL.replace(/content="[^"]*"/, 'content="Sober living - Weekly &amp; Monthly Rates available"');
  assert.ok(cl.parsePosting(hostel, 'u'));
});

test('with no declared period, an AirBnB-style title is rejected', () => {
  // "AirBnBish" at $25 was stored as $25 a month rather than $25 a night.
  const nightly = ROOM.replace('Pvt room furnished Miracle Mile area', 'AirBnBish short stay downtown');
  assert.equal(cl.parsePosting(nightly, 'u'), null);
});

test('takes the posting photo, because a queue of text rows cannot be reviewed', () => {
  const withPhoto = REAL.replace('<span class="price">',
    '<meta property="og:image" content="https://images.craigslist.org/00x0x_abc_600x450.jpg">\n<span class="price">');
  assert.match(cl.parsePosting(withPhoto, 'u').photoUrl, /00x0x_abc/);
});

test('the craigslist logo is not passed off as a photo of the place', () => {
  // Postings with no picture fall back to the site logo. Stored, it would put
  // the same graphic on hundreds of cards and read as "this one has a photo".
  const logo = REAL.replace('<span class="price">',
    '<meta property="og:image" content="https://www.craigslist.org/images/peace.jpg">\n<span class="price">');
  assert.equal(cl.parsePosting(logo, 'u').photoUrl, null);
  assert.equal(cl.photoUrl('<meta property="og:image" content="/relative/path.jpg">'), null);
  assert.equal(cl.photoUrl('<html></html>'), null);
});

test('a posting that omits the bathroom count stores null, not 1', () => {
  // A default is indistinguishable from a parsed value once it is in the
  // database, so the guess would be permanent and invisible.
  const noBa = REAL.replace('0BR / 1Ba 569ft<sup>2</sup> available now', '2BR 900ft<sup>2</sup>');
  assert.equal(cl.parsePosting(noBa, 'u').baths, null);
  // A stated one is still read.
  assert.equal(cl.parsePosting(REAL, 'u').baths, 1);
});

test('a whole-unit posting with no stated bed count is refused, not guessed at', () => {
  // Per-person rent is total ÷ beds, so without beds the one number the
  // product is built on cannot be derived. This used to write 1 and quote the
  // ENTIRE rent as one person's share.
  const noBr = REAL.replace('<div class="attrgroup"><span class="attr important">0BR / 1Ba 569ft<sup>2</sup> available now</span></div>', '');
  assert.equal(cl.parsePosting(noBr, 'u'), null);
});

test('a room with no stated bed count is still kept, because its price is per person', () => {
  // The bed count does not enter the arithmetic for a room, and 1 is what the
  // tenant actually gets.
  const room = REAL
    .replace(/content="[^"]*"/, 'content="Private room for rent in Westwood - rooms &amp; shares - apartment room"')
    .replace('<div class="attrgroup"><span class="attr important">0BR / 1Ba 569ft<sup>2</sup> available now</span></div>', '');
  const p = cl.parsePosting(room, 'u');
  assert.ok(p, 'a room should survive without a BR attribute');
  assert.equal(p.pricedPerPerson, true);
  assert.equal(p.beds, 1);
});

test('a stated bed count is still used', () => {
  assert.equal(cl.parsePosting(REAL, 'u').beds, 1);   // 0BR studio -> 1
});
