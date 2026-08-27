// ─── Replace fabricated fields on listings already stored ────────────────
//
//   node scripts/backfill-truth.js --dry-run
//   node scripts/backfill-truth.js --scope approved
//   node scripts/backfill-truth.js --scope all
//
// Two fields were invented rather than read, and shown to students as fact:
//
//   baths   Uloop never advertises it per building, so the adapter wrote 1 and
//           called it "the safe floor" — 230 of 480 approved listings.
//           Craigslist wrote 1 whenever a posting omitted it.
//   beds    Craigslist wrote 1 when a posting stated none, which then divided
//           the whole rent as though it were one person's share.
//
// A fabricated 1 cannot be told apart from a real 1 once it is in the table,
// so the only way to clean it is to go back to the source.
//
// This RE-PARSES in place rather than deleting and re-collecting. The recollect
// script would have worked, but it drops the rows and waits for the scheduler
// to walk the sitemaps again — hours with an empty housing tab to fix a field.
// Re-reading the pages we already have URLs for corrects the same data without
// a student ever seeing a gap.
//
// Uloop needs no fetch at all: its bath count was ALWAYS invented, on every
// row, so null is known to be the truth without asking anyone.

const pool = require('../src/db/pool');
const { politeFetch } = require('../src/services/collector');
const craigslist = require('../src/services/sources/craigslist');
const uloop = require('../src/services/sources/uloop');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const dryRun = process.argv.includes('--dry-run');
const scope = arg('scope', 'approved');
const limit = Number(arg('limit', '400'));
// One source at a time. A full pass re-fetches both, which at one request per
// second is longer than most shells will wait — and the two halves fix
// different things, so there is rarely a reason to run both.
const only = arg('only', null);

const statusFilter = scope === 'all' ? `moderation_status <> 'rejected'` : `moderation_status = 'approved'`;

(async () => {
  // ── Uloop: no fetch needed, the value was never real ────────────────────
  const { rows: [u] } = await pool.query(
    `SELECT count(*)::int n FROM listings
      WHERE source = 'uloop' AND baths IS NOT NULL AND ${statusFilter}`);
  console.log(`uloop: ${u.n} row(s) carrying an invented bath count`);
  if (!dryRun && u.n) {
    await pool.query(
      `UPDATE listings SET baths = NULL
        WHERE source = 'uloop' AND baths IS NOT NULL AND ${statusFilter}`);
  }

  // ── Uloop: recover the top of the price range ───────────────────────────
  //
  // The adapter always parsed it; the collector used to drop it. Without it a
  // building's cheapest floorplan is displayed as though it were the price,
  // and the sentence that said otherwise is truncated off the card. This does
  // need the page — unlike the bath count, the number was never ours to know.
  const { rows: ul } = await pool.query(
    `SELECT id, source_url, total_rent_cents FROM listings
      WHERE source = 'uloop' AND source_url IS NOT NULL
        AND high_rent_cents IS NULL AND ${statusFilter}
      LIMIT $1`, [limit]);
  console.log(`uloop: re-reading ${ul.length} page(s) for the price range`);
  let ranged = 0, single = 0;
  for (const r of ul) {
    const res = await politeFetch(r.source_url);
    if (!res.ok) continue;
    const parsed = uloop.parsePosting(res.body, r.source_url);
    if (!parsed) continue;
    if (parsed.highRentCents > r.total_rent_cents) {
      ranged++;
      if (!dryRun) await pool.query(`UPDATE listings SET high_rent_cents = $2 WHERE id = $1`, [r.id, parsed.highRentCents]);
    } else single++;
  }
  console.log(`  ${ranged} are ranges (now labelled "from"), ${single} are a single price
`);

  if (only === 'uloop') { await pool.end().catch(() => {}); return; }

  // ── Craigslist: only the page knows ─────────────────────────────────────
  const { rows } = await pool.query(
    `SELECT id, source_url, beds, baths, available_from, photo_urls FROM listings
      WHERE source = 'craigslist' AND source_url IS NOT NULL AND ${statusFilter}
      ORDER BY moderation_status, id
      LIMIT $1`, [limit]);

  console.log(`craigslist: re-reading ${rows.length} page(s)${dryRun ? ' (dry run)' : ''}\n`);

  let changed = 0, same = 0, gone = 0, failed = 0, refused = 0;

  for (const r of rows) {
    const res = await politeFetch(r.source_url);
    if (!res.ok) {
      if (res.gone) { gone++; if (!dryRun) await pool.query(`UPDATE listings SET is_active = FALSE, unavailable_at = now() WHERE id = $1`, [r.id]); }
      else failed++;
      continue;
    }

    const parsed = craigslist.parsePosting(res.body, r.source_url);
    if (!parsed) {
      // The page no longer parses under current rules — a for-sale price, a
      // whole unit with no bed count, an office. It should not be live.
      refused++;
      if (!dryRun) await pool.query(`UPDATE listings SET is_active = FALSE WHERE id = $1`, [r.id]);
      continue;
    }

    const bathsNow = r.baths == null ? null : Number(r.baths);
    const availNow = r.available_from ? new Date(r.available_from).toISOString().slice(0, 10) : null;
    const bathsSame = parsed.baths === bathsNow;
    const availSame = (parsed.availableFrom ?? null) === availNow;
    // A posting's gallery was never stored, so any of them is an improvement.
    const galleryNow = (r.photo_urls || []).length;
    const gallerySame = galleryNow >= (parsed.photoUrls || []).length;
    if (bathsSame && availSame && gallerySame) { same++; continue; }

    changed++;
    const notes = [];
    if (!bathsSame) notes.push(`baths ${bathsNow ?? 'null'} -> ${parsed.baths ?? 'null'}`);
    if (!availSame) notes.push(`available ${availNow ?? 'null'} -> ${parsed.availableFrom ?? 'null'}`);
    if (!gallerySame) notes.push(`photos ${galleryNow} -> ${(parsed.photoUrls || []).length}`);
    console.log(`  ${notes.join(' · ')}`);
    if (!dryRun) {
      await pool.query(
        `UPDATE listings SET baths = $2, available_from = $3,
                photo_urls = COALESCE($4::text[], photo_urls)
          WHERE id = $1`,
        [r.id, parsed.baths, parsed.availableFrom ?? null,
         parsed.photoUrls?.length ? parsed.photoUrls : null]);
    }
  }

  console.log(`\ncorrected ${changed} · already right ${same} · expired ${gone} · no longer valid ${refused} · failed ${failed}`);
  await pool.end().catch(() => {});
})().catch(e => { console.error('backfill failed:', e.message); process.exit(1); });
