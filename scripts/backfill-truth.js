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

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const dryRun = process.argv.includes('--dry-run');
const scope = arg('scope', 'approved');
const limit = Number(arg('limit', '400'));

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

  // ── Craigslist: only the page knows ─────────────────────────────────────
  const { rows } = await pool.query(
    `SELECT id, source_url, beds, baths FROM listings
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
    if (parsed.baths === bathsNow) { same++; continue; }

    changed++;
    console.log(`  baths ${bathsNow ?? 'null'} -> ${parsed.baths ?? 'null'}  ${r.source_url.slice(-28)}`);
    if (!dryRun) {
      await pool.query(`UPDATE listings SET baths = $2 WHERE id = $1`, [r.id, parsed.baths]);
    }
  }

  console.log(`\ncorrected ${changed} · already right ${same} · expired ${gone} · no longer valid ${refused} · failed ${failed}`);
  await pool.end().catch(() => {});
})().catch(e => { console.error('backfill failed:', e.message); process.exit(1); });
