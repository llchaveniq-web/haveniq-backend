const { Client } = require('pg');
const BASE = `is_active = TRUE AND moderation_status = 'approved'
  AND (per_person_rent_cents IS NULL OR per_person_rent_cents <= 600000)`;
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const keys = {
    'addr+rent+beds':       `lower(trim(address)), coalesce(per_person_rent_cents,-1), coalesce(beds,-1)`,
    'addr+rent+beds+baths': `lower(trim(address)), coalesce(per_person_rent_cents,-1), coalesce(beds,-1), coalesce(baths,-1)`,
    'addr+beds':            `lower(trim(address)), coalesce(beds,-1)`,
  };
  const tot = (await c.query(`SELECT count(*) n FROM listings WHERE ${BASE}`)).rows[0].n;
  console.log('rows passing the live filters: ' + tot);
  console.log('');
  for (const [name, k] of Object.entries(keys)) {
    const r = await c.query(`SELECT count(*) n FROM (SELECT DISTINCT ${k} FROM listings WHERE ${BASE}) s`);
    console.log('  ' + name.padEnd(22) + ' -> ' + String(r.rows[0].n).padStart(6)
      + '  (' + Math.round(r.rows[0].n / tot * 100) + '% of rows kept)');
  }

  // Does a stricter key ever SPLIT what the looser one joins? i.e. are there
  // same address+rent+beds groups with genuinely different bath counts?
  const split = await c.query(`
    SELECT count(*) n FROM (
      SELECT lower(trim(address)) a, per_person_rent_cents p, beds b,
             count(DISTINCT coalesce(baths,-1)) nb
      FROM listings WHERE ${BASE}
      GROUP BY 1,2,3 HAVING count(DISTINCT coalesce(baths,-1)) > 1
    ) s`);
  console.log('');
  console.log('  groups where baths disagree within addr+rent+beds: ' + split.rows[0].n);

  // What would we keep? Prefer a row that HAS photos, then the freshest.
  const sample = await c.query(`
    SELECT DISTINCT ON (lower(trim(address)), coalesce(per_person_rent_cents,-1), coalesce(beds,-1))
           address, per_person_rent_cents AS rent, beds,
           coalesce(array_length(photo_urls,1),0) AS nphotos, source_posted_at
    FROM listings WHERE ${BASE}
    ORDER BY lower(trim(address)), coalesce(per_person_rent_cents,-1), coalesce(beds,-1),
             (coalesce(array_length(photo_urls,1),0) > 0) DESC,
             source_posted_at DESC NULLS LAST, created_at DESC
    LIMIT 5`);
  console.log('');
  console.log('  kept rows (sample):');
  for (const r of sample.rows) console.log('    ' + r.address.slice(0,34).padEnd(36) + ' photos=' + r.nphotos);

  // How many kept rows would have NO photo if we did not prefer photos?
  const noPhotoNaive = await c.query(`
    SELECT count(*) FILTER (WHERE nphotos = 0) AS n FROM (
      SELECT DISTINCT ON (lower(trim(address)), coalesce(per_person_rent_cents,-1), coalesce(beds,-1))
             coalesce(array_length(photo_urls,1),0) AS nphotos
      FROM listings WHERE ${BASE}
      ORDER BY lower(trim(address)), coalesce(per_person_rent_cents,-1), coalesce(beds,-1),
               source_posted_at DESC NULLS LAST
    ) s`);
  const noPhotoPref = await c.query(`
    SELECT count(*) FILTER (WHERE nphotos = 0) AS n FROM (
      SELECT DISTINCT ON (lower(trim(address)), coalesce(per_person_rent_cents,-1), coalesce(beds,-1))
             coalesce(array_length(photo_urls,1),0) AS nphotos
      FROM listings WHERE ${BASE}
      ORDER BY lower(trim(address)), coalesce(per_person_rent_cents,-1), coalesce(beds,-1),
               (coalesce(array_length(photo_urls,1),0) > 0) DESC, source_posted_at DESC NULLS LAST
    ) s`);
  console.log('');
  console.log('  kept rows with NO photo, freshest-only     : ' + noPhotoNaive.rows[0].n);
  console.log('  kept rows with NO photo, prefer-has-photos : ' + noPhotoPref.rows[0].n);
  await c.end();
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
