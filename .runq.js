// Runs the exact query the route now builds, both ways, against live data.
const { Client } = require('pg');
const DEDUPE_KEY = 'lower(trim(address)), coalesce(per_person_rent_cents,-1), coalesce(beds,-1), coalesce(baths,-1)';
const DEDUPE_PICK = '(coalesce(array_length(photo_urls,1),0) > 0) DESC, source_posted_at DESC NULLS LAST, created_at DESC';

const q = (DEDUPE) => `SELECT * FROM (
   SELECT ${DEDUPE ? 'DISTINCT ON (' + DEDUPE_KEY + ')' : ''}
          id, address, beds, baths, per_person_rent_cents, photo_urls, created_at
   FROM listings
   WHERE is_active = TRUE AND moderation_status = 'approved'
     AND (per_person_rent_cents IS NULL OR per_person_rent_cents <= 600000)
   ${DEDUPE ? 'ORDER BY ' + DEDUPE_KEY + ', ' + DEDUPE_PICK : ''}
 ) d
 ORDER BY created_at DESC
 LIMIT $1 OFFSET 0`;

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  for (const on of [false, true]) {
    const t0 = Date.now();
    const r = await c.query(q(on), [500]);
    const ms = Date.now() - t0;
    const key = x => [String(x.address).trim().toLowerCase(), x.per_person_rent_cents, x.beds, x.baths].join('|');
    const uniq = new Set(r.rows.map(key)).size;
    const noPhoto = r.rows.filter(x => !(x.photo_urls || []).length).length;
    console.log((on ? 'DEDUPE ON ' : 'DEDUPE OFF') + '  rows=' + r.rows.length
      + '  distinct places=' + uniq
      + '  photoless=' + noPhoto
      + '  ' + ms + 'ms');
  }
  // The thing that must not happen: a place present without dedupe that is
  // absent with it.
  const off = new Set((await c.query(q(false), [5000])).rows
    .map(x => [String(x.address).trim().toLowerCase(), x.per_person_rent_cents, x.beds, x.baths].join('|')));
  const on = new Set((await c.query(q(true), [5000])).rows
    .map(x => [String(x.address).trim().toLowerCase(), x.per_person_rent_cents, x.beds, x.baths].join('|')));
  const lost = [...off].filter(k => !on.has(k));
  console.log('');
  console.log('  distinct places in the un-deduped 5000: ' + off.size);
  console.log('  ...of which MISSING after dedupe      : ' + lost.length + (lost.length ? '  <-- BAD' : '  (none lost)'));
  await c.end();
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
