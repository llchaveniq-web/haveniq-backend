// Uloop adapter — schema.org extraction for per-campus student housing.
//
// The fixture is the real JSON-LD ucla.uloop.com served HavenIQBot on
// 2026-08-26, trimmed. What gets tested hardest is the range handling: a Uloop
// page is usually a BUILDING with several floorplans, and every way of
// flattening that into one number is a different lie about the one figure a
// student decides on.
//
// node --test.
const test = require('node:test');
const assert = require('node:assert');
const ul = require('./uloop');

const REAL = `
<script type="application/ld+json">{"@graph":[{
  "@context":"http://schema.org","@type":"LocalBusiness","name":"900 S Figueroa St",
  "url":"https://ucla.uloop.com/housing/view.php/1651975941/900-S-Figueroa-St",
  "priceRange":"$2882-$7744",
  "geo":{"@type":"GeoCoordinates","latitude":"34.0458412","longitude":"-118.2628784"},
  "address":{"@type":"PostalAddress","addressLocality":"Los Angeles","addressRegion":"CA",
             "postalCode":"90015","streetAddress":"900 S Figueroa St"},
  "image":{"@type":"ImageObject","url":"https://uloop.com/img/uloop-splash-screen-960x419.png"},
  "description":"PHOTOS ARE AN EXAMPLE OF SIMILAR UNITS WITHIN THE BUILDING."
}]}</script>
<div>1 BR</div><div>2 BR</div><div>3 BR</div>`;

const SITEMAP = `<urlset>
  <url><loc>https://ucla.uloop.com/housing/view.php/123/A-St</loc></url>
  <url><loc>https://ucla.uloop.com/jobs/view.php/456/Barista</loc></url>
  <url><loc>https://ucla.uloop.com/tutors/view.php/789/Calc</loc></url>
  <url><loc>https://ucla.uloop.com/study-abroad-housing/view.php/1/Rome</loc></url>
</urlset>`;

test('takes housing pages and nothing else from the sitemap', () => {
  // The sitemap also carries jobs, tutors, travel and online courses. Only one
  // of those is somewhere to live.
  const got = ul.housingUrls(SITEMAP);
  assert.equal(got.length, 1);
  assert.ok(got[0].includes('/housing/view.php/'));
});

test('study-abroad housing is not local housing', () => {
  // 1,383 of UCLA's sitemap entries are study-abroad-housing — accommodation in
  // another country, which is not what a student browsing near campus wants.
  assert.ok(!ul.housingUrls(SITEMAP).some(u => u.includes('study-abroad')));
});

test('extracts a real street address and coordinates from the JSON-LD', () => {
  const p = ul.parsePosting(REAL, 'u');
  assert.equal(p.address, '900 S Figueroa St');
  assert.equal(p.city, 'Los Angeles');
  assert.equal(p.latitude, 34.0458412);
  assert.equal(p.longitude, -118.2628784);
});

test('stores the LOW end of the range as the rent', () => {
  // A student filtering by budget is asking "can I live here". The cheapest
  // floorplan answers that; the high end would hide buildings they can afford,
  // and the midpoint is a number that exists nowhere.
  const p = ul.parsePosting(REAL, 'u');
  assert.equal(p.totalRentCents, 288200);
  assert.equal(p.highRentCents, 774400);
  assert.equal(p.isRange, true);
});

test('says in the notes that the price is a from-price on a building', () => {
  // The range must not vanish. A student who sees $2,882 and turns up to find
  // nothing under $5,000 has been misled by us, not by Uloop.
  const p = ul.parsePosting(REAL, 'u');
  assert.match(p.notes, /\$2,882–\$7,744/);
  assert.match(p.notes, /lowest floorplan/i);
  assert.match(p.notes, /1BR, 2BR, 3BR/);
});

test('rejects the stock splash image rather than passing it off as the building', () => {
  // Uloop's JSON-LD falls back to its own splash screen. Stored, it would put
  // the same graphic on every listing as though it were a photo of the place.
  const p = ul.parsePosting(REAL, 'u');
  assert.equal(p.photoUrl, null);
});

test('falls back to og:image, which is where the real photo actually lives', () => {
  // The JSON-LD image is the splash on EVERY Uloop housing page. Reading only
  // it produced 376 collected listings with no photo while the pages carried
  // real ones all along.
  const withOg = REAL + '<meta property="og:image" content="https://be.rentalbeast.com/listings/5366789.jpg?w=880"/>';
  assert.match(ul.parsePosting(withOg, 'u').photoUrl, /rentalbeast\.com/);
});

test('falls back to the lazy-loaded gallery, adding the missing scheme', () => {
  // The gallery uses data-src, so the images never appear in a src attribute,
  // and the URLs are protocol-relative — unusable until a scheme is added.
  const lazy = REAL + '<img data-src="//d31gnh3j8cblbd.uloop.com/abc/Housing-Near-UCLA">';
  assert.equal(ul.parsePosting(lazy, 'u').photoUrl,
    'https://d31gnh3j8cblbd.uloop.com/abc/Housing-Near-UCLA');
});

test('og:image is preferred over the gallery, and a real JSON-LD image over both', () => {
  const both = REAL
    + '<meta property="og:image" content="https://be.rentalbeast.com/listings/1.jpg"/>'
    + '<img data-src="//cdn.uloop.com/x/y">';
  assert.match(ul.parsePosting(both, 'u').photoUrl, /rentalbeast/);

  const real = REAL.replace('uloop-splash-screen-960x419.png', 'property/9482/front.jpg');
  assert.match(ul.parsePosting(real + '<meta property="og:image" content="https://other/z.jpg"/>', 'u').photoUrl,
    /front\.jpg$/);
});

test('a placeholder in any of the three slots is still refused', () => {
  const ph = REAL + '<meta property="og:image" content="https://uloop.com/img/uloop-splash-screen.png"/>'
                  + '<img data-src="//cdn.uloop.com/img/favicon/32_32.png">';
  assert.equal(ul.parsePosting(ph, 'u').photoUrl, null);
});

test('keeps a genuine photo', () => {
  const withPhoto = REAL.replace('uloop-splash-screen-960x419.png', 'property/9482/front.jpg');
  assert.match(ul.parsePosting(withPhoto, 'u').photoUrl, /front\.jpg$/);
});

test('a single-price listing is not reported as a range', () => {
  const one = REAL.replace('"$2882-$7744"', '"$1950"');
  const p = ul.parsePosting(one, 'u');
  assert.equal(p.totalRentCents, 195000);
  assert.equal(p.isRange, false);
  assert.doesNotMatch(p.notes, /across floorplans/);
});

test('a studio is stored as 1 bed and flagged', () => {
  const studio = REAL.replace('<div>1 BR</div>', '<div>0 BR</div>');
  const p = ul.parsePosting(studio, 'u');
  assert.equal(p.beds, 1);
  assert.equal(p.isStudio, true);
});

test('drops a page with no address, no price or no coordinates', () => {
  for (const broken of [
    REAL.replace('"streetAddress":"900 S Figueroa St"', '"streetAddress":""'),
    REAL.replace('"priceRange":"$2882-$7744",', ''),
    REAL.replace('"latitude":"34.0458412"', '"latitude":"abc"'),
  ]) {
    assert.equal(ul.parsePosting(broken, 'u'), null);
  }
});

test('malformed input degrades to null instead of throwing', () => {
  for (const junk of ['', '<html></html>', null, undefined, '<script type="application/ld+json">{oops</script>']) {
    assert.doesNotThrow(() => ul.parsePosting(junk, 'u'));
    assert.equal(ul.parsePosting(junk, 'u'), null);
  }
});
