// ─── Which Craigslist regions actually publish a housing sitemap ────────────
//
//   node scripts/list-regions.js
//   node scripts/list-regions.js --match "sf|sandiego|sac"
//
// Adding a campus means adding a COLLECT_TARGETS entry, and the region code in
// it is not guessable. I have already been burned once on this project by
// inventing hostnames that did not resolve and reporting the result as
// coverage. Craigslist publishes the answer — a sitemap index naming every
// region it partitions postings by — so read it rather than assume.
//
// One request to a file robots.txt permits, then string matching. Nothing is
// fetched per region.

const { politeFetch } = require('../src/services/collector');

const SITEMAP_INDEX = 'https://www.craigslist.org/sitemap-index-postings-00.xml';
const CATEGORY = 'hhh';                       // housing

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

(async () => {
  const res = await politeFetch(SITEMAP_INDEX);
  if (!res || !res.body) {
    console.error('could not read the sitemap index', res && res.status);
    process.exit(1);
  }

  // Entries look like
  //   /sitemap-postings-2026-08-28-lax-hhh.xml
  // so the region is the segment immediately before the category, after a date
  // that itself contains dashes. Anchoring on "sitemap-<region>-" matches
  // nothing — and my first attempt did exactly that, then printed
  // "0 regions publish a hhh sitemap", which reads as a fact about Craigslist
  // rather than a broken regex.
  const re = new RegExp(`-([a-z0-9]+)-${CATEGORY}\\.xml`, 'gi');
  const counts = new Map();
  let m;
  while ((m = re.exec(res.body))) {
    const r = m[1].toLowerCase();
    counts.set(r, (counts.get(r) || 0) + 1);
  }

  const filter = arg('match', null);
  const rx = filter ? new RegExp(filter, 'i') : null;
  const regions = [...counts.keys()].filter(r => !rx || rx.test(r)).sort();

  console.log(`${counts.size} regions publish a ${CATEGORY} sitemap`);
  if (filter) console.log(`matching /${filter}/i: ${regions.length}`);
  console.log(regions.join(' '));
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
