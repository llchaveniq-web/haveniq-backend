// ─── Discard unapproved collected listings so they are collected again ─────
//
//   node scripts/recollect.js --source craigslist --dry-run
//   node scripts/recollect.js --source craigslist
//
// Run this after changing how a source is parsed. The first live run stored
// rooms at total ÷ beds — a real $650 room in a 3BR filed as $216 — and let an
// office and a nightly rate into the queue.
//
// It deletes rather than repairs, on purpose. A repair script has to restate
// the parser's rules in SQL, and the two drift apart the moment either is
// edited; worse, the stored notes hold the CLEANED title, so the category
// boilerplate the parser reads is already gone and a repair cannot see what the
// parser sees. Deleting and re-collecting runs the real parser over the real
// page, which is the only thing guaranteed to agree with itself.
//
// SAFETY. Only rows this collector created that a human has NOT approved. An
// approved listing, or one a student posted, is never touched — re-collecting
// something a moderator already cleared would silently undo their decision.
//
// It also clears the collector_seen entries that record OUR decisions
// ('stored', 'skipped'), because those were made under the old rules. Entries
// recording the SITE's answer ('expired' — a 404/410) are left alone: the
// parser changing does not bring a deleted posting back.

const pool = require('../src/db/pool');

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : null; };
const source = arg('source');
const dryRun = process.argv.includes('--dry-run');

if (!source) { console.error('--source is required (craigslist, uloop)'); process.exit(1); }

(async () => {
  const { rows: [n] } = await pool.query(
    `SELECT count(*) FILTER (WHERE moderation_status <> 'approved')::int discard,
            count(*) FILTER (WHERE moderation_status  = 'approved')::int keep
       FROM listings WHERE source = $1`, [source]);
  const { rows: [s] } = await pool.query(
    `SELECT count(*) FILTER (WHERE outcome IN ('stored','skipped'))::int clearable,
            count(*) FILTER (WHERE outcome = 'expired')::int kept
       FROM collector_seen WHERE source = $1`, [source]);

  console.log(`${source}: discarding ${n.discard} unapproved listing(s), keeping ${n.keep} approved`);
  console.log(`  collector_seen: clearing ${s.clearable} of our own decisions, keeping ${s.kept} expired\n`);

  if (dryRun) { console.log('dry run — nothing written'); await pool.end().catch(() => {}); return; }

  await pool.query(`DELETE FROM listings WHERE source = $1 AND moderation_status <> 'approved'`, [source]);
  await pool.query(`DELETE FROM collector_seen WHERE source = $1 AND outcome IN ('stored','skipped')`, [source]);
  console.log('done — the next collector cycle will re-read these with current rules');

  await pool.end().catch(() => {});
})().catch(e => { console.error('recollect failed:', e.message); process.exit(1); });
