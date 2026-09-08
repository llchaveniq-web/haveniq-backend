const { Client } = require('pg');
const K = 'lower(trim(address)), coalesce(per_person_rent_cents,-1), coalesce(beds,-1), coalesce(baths,-1)';
const PICK = '(coalesce(array_length(photo_urls,1),0) > 0) DESC, source_posted_at DESC NULLS LAST, created_at DESC';

// group_created_at: the freshest post in the group. The row we SHOW may be an
// older one (picked because it has photos), but the group's place in the list
// must reflect how recently it was posted, or preferring photos can push a
// place below the LIMIT and out of the results entirely.
const q = (D) => `SELECT * FROM (
   SELECT ${D ? 'DISTINCT ON (' + K + ')' : ''}
          id, address, beds, baths, per_person_rent_cents, photo_urls, created_at
          ${D ? ', max(created_at) OVER (PARTITION BY ' + K + ') AS group_created_at' : ''}
   FROM listings
   WHERE is_active = TRUE AND moderation_status = 'approved'
     AND (per_person_rent_cents IS NULL OR per_person_rent_cents <= 600000)
   ${D ? 'ORDER BY ' + K + ', ' + PICK : ''}
 ) d
 ORDER BY ${D ? 'group_created_at' : 'created_at'} DESC
 LIMIT $1 OFFSET 0`;

const key = x => [String(x.address).trim().toLowerCase(), x.per_person_rent_cents, x.beds, x.baths].join('|');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  for (const on of [false, true]) {
    const t0 = Date.now();
    const r = await c.query(q(on), [500]);
    console.log((on ? 'DEDUPE ON ' : 'DEDUPE OFF') + '  rows=' + r.rows.length
      + '  distinct=' + new Set(r.rows.map(key)).size
      + '  photoless=' + r.rows.filter(x => !(x.photo_urls || []).length).length
      + '  ' + (Date.now() - t0) + 'ms');
  }
  for (const N of [500, 5000]) {
    const off = new Set((await c.query(q(false), [N])).rows.map(key));
    const on  = new Set((await c.query(q(true),  [N])).rows.map(key));
    const lost = [...off].filter(k => !on.has(k));
    console.log('  at LIMIT ' + N + ': places in raw=' + off.size + ', missing after dedupe=' + lost.length
      + (lost.length ? '  <-- BAD' : '  (none lost)'));
  }
  await c.end();
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
