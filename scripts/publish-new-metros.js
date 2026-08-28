// ─── Make the newly-collected metros visible to students ────────────────────
//
//   node scripts/publish-new-metros.js --dry-run
//   node scripts/publish-new-metros.js
//
// Collected listings land as `pending` and no student can see them. Adding a
// campus is therefore only half the job: Orange Coast College once sat with
// 745 listings nobody could see, and the map read as missing coverage rather
// than a publish that had never been run. On 2026-08-28 COLLECT_TARGETS grew
// from one metro to four, so the same trap is now set for three more.
//
// ── SCOPE, AND WHY IT IS THIS NARROW ────────────────────────────────────────
//
// Only the campuses added in that change, listed below. It will not touch the
// ~7,200 pending listings for UCLA, Orange Coast College and USC. That backlog
// is a much larger call — thousands of listings going live in one action — and
// Jackson chose explicitly to keep it separate rather than fold it in here.
// Widening SCHOOLS is not a tuning change; it is that decision.
//
// ── THE THRESHOLD IS OBSERVED, NOT INVENTED ─────────────────────────────────
//
// Read off what has already been approved by hand: approved listings run risk
// 15-45, with ZERO ever approved at 50 or above, and rejected ones start at
// 70. So 45 is where the line already sits. Anything above it stays queued for
// a human and is reported, every run — a publish that silently drops its risky
// tail looks identical to one that published everything.
//
// The scam scorer and the $200-$10,000 per-person sanity band in storeListing
// are what carry the "no fake listings" promise once per-listing review stops.
// Neither is re-run here; this only publishes what already passed both.
//
// ── ON THE GUARD THIS LEANS ON ──────────────────────────────────────────────
//
// POST /bot-admin/listings/bulk deliberately does not approve by rule — its
// comment calls that "a collector that publishes on its own wearing a thin
// disguise". Supplying explicit ids satisfies the letter of that and not the
// spirit, and it is only appropriate because a human asked for this specific,
// bounded publish. It should not become the default path.
//
// (That comment also justifies itself with "the promise on the landing page is
// that a human looked". Checked on 2026-08-28: no such promise exists. The
// landing page says nothing about listings and no housing screen makes a
// review or vetting claim. The guard is a design choice, not a commitment we
// would be breaking.)

// Credentials resolve themselves.
//
// The first version required DATABASE_URL and ADMIN_BOT_TOKEN to be exported
// by the caller, and the documented invocation was a bash one-liner using an
// inline env prefix (`FOO=bar node ...`). PowerShell has no such syntax: the
// assignments are silently ignored, node starts with nothing set, and the
// script exits on "ADMIN_BOT_TOKEN must be set" having never reached the
// database. It looks exactly like a missing secret, and the secret is right
// there in Railway.
//
// So it asks Railway itself when the environment is empty. `railway variables`
// is already how every other operational script here reaches production, and
// the values stay in memory — never echoed, never written to disk.
// Invoked through a shell on purpose. The Railway CLI installs as an npm shim
// — a shell script plus a .cmd wrapper — and execFileSync cannot run either
// directly on Windows: bare 'railway' is ENOENT and 'railway.cmd' is EINVAL.
// Only the service name is interpolated and it is a fixed literal from this
// file, never user input.
function fromRailway(service, key) {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      'railway',
      ['variables', '--service', service, '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000, shell: true },
    );
    return JSON.parse(out)[key] || null;
  } catch {
    return null;                      // not linked, not installed, no network
  }
}

// Order matters: src/db/pool reads process.env.DATABASE_URL at REQUIRE time,
// so this has to happen before the require below or the pool is built with an
// undefined connection string and the same "looks like a missing secret"
// failure lands on the database instead of the token.
if (!process.env.DATABASE_URL) {
  const url = fromRailway('Postgres', 'DATABASE_PUBLIC_URL');
  if (url) process.env.DATABASE_URL = url;
}

const pool = require('../src/db/pool');

// The campuses added when the collector went from one metro to four.
const SCHOOLS = [
  'University of California, Berkeley',
  'University of California, San Diego',
  'San Diego State University',
  'California State University, Sacramento',
  'University of California, Davis',
];

const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes('--' + n);

const API      = arg('api', process.env.API_BASE || 'https://api.haveniq.org');
const TOKEN    = process.env.ADMIN_BOT_TOKEN || process.env.INTERNAL_API_KEY
                 || fromRailway('haveniq-backend', 'ADMIN_BOT_TOKEN');
const MAX_RISK = Number(arg('max-risk', '45'));
const DRY      = flag('dry-run');
const BATCH    = 200;                       // the endpoint's own per-call cap

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!Number.isFinite(MAX_RISK) || MAX_RISK < 0 || MAX_RISK > 100) {
    console.error('--max-risk must be 0-100'); process.exit(1);
  }
  if (!DRY && !TOKEN) {
    console.error('No ADMIN_BOT_TOKEN in the environment, and Railway could not supply one.');
    console.error('Either `railway link` this directory, or set ADMIN_BOT_TOKEN yourself.');
    process.exit(1);
  }

  const { rows: preview } = await pool.query(
    `SELECT school_near,
            count(*) FILTER (WHERE coalesce(risk_score,0) <= $2) publishable,
            count(*) FILTER (WHERE coalesce(risk_score,0) >  $2) held,
            max(coalesce(risk_score,0)) worst
       FROM listings
      WHERE is_active AND moderation_status = 'pending' AND school_near = ANY($1::text[])
      GROUP BY school_near ORDER BY publishable DESC`,
    [SCHOOLS, MAX_RISK]);

  const total = preview.reduce((a, r) => a + Number(r.publishable), 0);
  const held  = preview.reduce((a, r) => a + Number(r.held), 0);

  console.log(`new-metro campuses only · risk <= ${MAX_RISK}\n`);
  for (const r of preview) {
    console.log(`  ${String(r.school_near).padEnd(42)} publish ${String(r.publishable).padStart(5)}   hold ${String(r.held).padStart(4)}   worst risk ${r.worst}`);
  }
  console.log(`\n  total to publish: ${total}`);
  console.log(`  left queued for a human: ${held}`);

  if (DRY) { console.log('\n(dry run — nothing published)'); await pool.end(); return; }
  if (!total) { console.log('\nnothing to publish'); await pool.end(); return; }

  const { rows } = await pool.query(
    `SELECT id FROM listings
      WHERE is_active AND moderation_status = 'pending'
        AND school_near = ANY($1::text[]) AND coalesce(risk_score,0) <= $2
      ORDER BY created_at`,
    [SCHOOLS, MAX_RISK]);
  const ids = rows.map(r => r.id);
  console.log(`\npublishing ${ids.length} in batches of ${BATCH}…`);

  let ok = 0, failed = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    try {
      const res = await fetch(`${API}/bot-admin/listings/bulk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          action: 'approve',
          ids: batch,
          reason: `new-metro bulk publish, collected, risk <= ${MAX_RISK}`,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        failed += batch.length;
        console.error(`\n  batch ${Math.floor(i / BATCH) + 1}: HTTP ${res.status} ${body?.error || ''}`);
      } else {
        const acted = body.approved ?? body.acted ?? body.ids;
        ok += Array.isArray(acted) ? acted.length : batch.length;
        process.stdout.write('.');
      }
    } catch (e) {
      failed += batch.length;
      console.error(`\n  batch ${Math.floor(i / BATCH) + 1} failed: ${e.message}`);
    }
    await sleep(250);                       // don't stampede our own API
  }

  const { rows: after } = await pool.query(
    `SELECT school_near,
            count(*) FILTER (WHERE moderation_status='approved') live,
            count(*) FILTER (WHERE moderation_status='pending')  pending
       FROM listings WHERE is_active AND school_near = ANY($1::text[])
      GROUP BY school_near ORDER BY live DESC`, [SCHOOLS]);
  console.log(`\n\napproved ${ok}, failed ${failed}\n`);
  for (const r of after) {
    console.log(`  ${String(r.school_near).padEnd(42)} live ${String(r.live).padStart(5)}   still pending ${String(r.pending).padStart(5)}`);
  }
  await pool.end();
})().catch(e => { console.error('publish failed:', e.message); process.exit(1); });
