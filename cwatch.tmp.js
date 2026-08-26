const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const { rows } = await c.query(
    `SELECT source, count(*)::int n, count(photo_url)::int photos
       FROM listings WHERE source IS NOT NULL GROUP BY 1 ORDER BY 1`);
  console.log(rows.map(r => `${r.source} ${r.n} rows/${r.photos} photos`).join(' · ') || 'empty');
  await c.end();
})().catch(e => console.log('err', e.message));
