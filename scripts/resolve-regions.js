// ─── What city is a Craigslist region code, actually? ────────────────────────
//
//   node scripts/resolve-regions.js sfo sdo sac sba
//
// list-regions.js says which codes exist. It does not say what they MEAN, and
// the codes are not inferable: 'lax' is Los Angeles but 'orc' is Orange County
// and 'osu' is anyone's guess. Filing listings under the wrong campus is the
// exact class of invented data the moderation queue exists to prevent, so this
// resolves each code from the source instead: fetch its housing sitemap, read
// the first posting URL, and report the hostname Craigslist itself used.
//
// One request per code, through the same polite fetcher as the collector.

const { politeFetch } = require('../src/services/collector');

const CATEGORY = 'hhh';
const INDEX = 'https://www.craigslist.org/sitemap-index-postings-00.xml';

(async () => {
  const codes = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (!codes.length) {
    console.error('usage: node scripts/resolve-regions.js <code> [code...]');
    process.exit(1);
  }

  const idx = await politeFetch(INDEX);
  if (!idx || !idx.body) { console.error('sitemap index unreadable'); process.exit(1); }
  const locs = [...idx.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);

  for (const code of codes) {
    const url = locs.find(u => u.endsWith(`-${code}-${CATEGORY}.xml`));
    if (!url) { console.log(`${code.padEnd(6)} — no ${CATEGORY} sitemap`); continue; }

    const res = await politeFetch(url);
    if (!res || !res.body) { console.log(`${code.padEnd(6)} — sitemap unreadable (${res && res.status})`); continue; }

    const first = (res.body.match(/<loc>([^<]+)<\/loc>/) || [])[1] || '';
    let host = '';
    try { host = new URL(first).hostname; } catch { /* leave blank */ }
    const count = (res.body.match(/<loc>/g) || []).length;
    console.log(`${code.padEnd(6)} ${host.padEnd(34)} ${count} postings`);
  }
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
