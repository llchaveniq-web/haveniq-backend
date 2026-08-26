// ─── Collect listings from a source into the moderation queue ─────────────
//
//   node scripts/collect-listings.js --region lax --school "UCLA" --dry-run
//   node scripts/collect-listings.js --region lax --school "UCLA" --limit 25
//
// Reads a source's own sitemaps, obeys its robots.txt, fetches one posting per
// second, scores each for scam signals, and files them as PENDING. Nothing it
// collects is visible to a student until a human approves it in
// /bot-admin/pending-listings.
//
// --school is REQUIRED and is not guessed. A Craigslist region covers a metro,
// not a campus, and deciding on a student's behalf which school a posting is
// "near" is exactly the invented data the moderation queue exists to keep out.
//
// Start with --dry-run. It fetches and parses but writes nothing, so you can
// see what a run would produce before any of it reaches the queue.

const pool = require('../src/db/pool');
const { collect } = require('../src/services/collector');
const craigslist = require('../src/services/sources/craigslist');

const SOURCES = { craigslist };

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

(async () => {
  const sourceName = arg('source', 'craigslist');
  const region = arg('region');
  const school = arg('school');
  const city = arg('city');
  const limit = Number(arg('limit', '25'));
  const dryRun = flag('dry-run');

  const adapter = SOURCES[sourceName];
  if (!adapter) { console.error(`unknown source "${sourceName}". known: ${Object.keys(SOURCES).join(', ')}`); process.exit(1); }
  if (!region) { console.error('--region is required (e.g. lax, sfo, nyc)'); process.exit(1); }
  if (!school && !dryRun) { console.error('--school is required for a real run (e.g. --school "UCLA")'); process.exit(1); }
  if (!Number.isFinite(limit) || limit < 1 || limit > 500) { console.error('--limit must be 1-500'); process.exit(1); }

  console.log(`source ${sourceName} · region ${region} · school ${school || '(dry run)'} · limit ${limit}\n`);

  const stats = await collect(adapter, { region, schoolNear: school, city, limit, dryRun });

  await pool.end().catch(() => {});
  // Blocked is not a failure to exit non-zero over — a site saying no is a
  // valid outcome and a human should read it, not a CI job that goes red.
  process.exit(stats.failed > 0 ? 1 : 0);
})().catch(err => { console.error('collect failed:', err); process.exit(1); });
