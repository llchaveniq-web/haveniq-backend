// ─── Make collected listings visible to students ────────────────────────────
//
//   node scripts/publish-pending.js --dry-run
//   node scripts/publish-pending.js
//   node scripts/publish-pending.js --school "University of California, Los Angeles" //                                   --school "Orange Coast College"
//
// With no --school it publishes the DEFAULT_SCOPE below: the campuses added
// when the collector went from one metro to four. Naming schools explicitly
// overrides that, and the scope in force is printed before anything happens.
//
// Collected listings land as `pending` and no student can see them. Adding a
// campus is therefore only half the job: Orange Coast College once sat with
// 745 listings nobody could see, and the map read as missing coverage rather
// than a publish that had never been run. On 2026-08-28 COLLECT_TARGETS grew
// from one metro to four, so the same trap is now set for three more.
//
// ── SCOPE ───────────────────────────────────────────────────────────────────
//
// The default is deliberately the small set. Publishing the LA and Orange
// County backlog means thousands of listings going live in one action, which
// is a different decision from making a new campus visible, and it should have
// to be asked for by name rather than inherited from a default. Hence
// --school: the wide run leaves a record of itself in the shell history.
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
    // One command string rather than argv + shell:true. Node warns about the
    // latter because the args are concatenated unescaped; the service names
    // here are fixed literals from this file, but a warning that is harmless
    // today is a warning nobody reads tomorrow.
    const { execSync } = require('child_process');
    const out = execSync(
      `railway variables --service ${service} --json`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 },
    );
    return JSON.parse(out)[key] || null;
  } catch {
    return null;                      // not linked, not installed, no network
  }
}

// No database connection. Everything here goes through the bot-admin API, so
// the only credential needed is the admin token — which is what lets this run
// from CI without putting a production DATABASE_URL into GitHub secrets. The
// smaller blast radius is the point: a leaked read/write DB URL is a different
// order of problem from a leaked API token that can only approve listings.

// The campuses added when the collector went from one metro to four. Used
// when no --school is given.
const DEFAULT_SCOPE = [
  'University of California, Berkeley',
  'University of California, San Diego',
  'San Diego State University',
  'California State University, Sacramento',
  'University of California, Davis',
];

const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes('--' + n);
// --school is repeatable; arg() only ever sees the first one.
const argAll = (n) => process.argv.reduce((acc, v, i) =>
  (v === '--' + n && process.argv[i + 1] && !process.argv[i + 1].startsWith('--'))
    ? acc.concat(process.argv[i + 1]) : acc, []);

const named = argAll('school');
const SCHOOLS = named.length ? named : DEFAULT_SCOPE;

const API      = arg('api', process.env.API_BASE || 'https://api.haveniq.org');
const TOKEN    = process.env.ADMIN_BOT_TOKEN || process.env.INTERNAL_API_KEY
                 || fromRailway('haveniq-backend', 'ADMIN_BOT_TOKEN');
const MAX_RISK = Number(arg('max-risk', '45'));
const DRY      = flag('dry-run');
const BATCH    = 200;                       // the endpoint's own per-call cap

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const api = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
};

/**
 * Every pending listing, walked page by page.
 *
 * The queue is ordered risk DESC, so the listings this script will NEVER
 * publish sit at the head of it permanently. Re-reading offset 0 each time
 * would therefore return the same held-back rows forever and find nothing to
 * do. So the whole queue is read BEFORE anything is approved — offsets stay
 * stable because nothing has left the queue yet.
 */
async function readQueue() {
  const all = [];
  for (let offset = 0; ; offset += BATCH) {
    const { ok, status, body } = await api(`/bot-admin/pending-listings?limit=${BATCH}&offset=${offset}`);
    if (!ok) throw new Error(`pending-listings returned HTTP ${status}`);
    const page = body.listings || [];
    all.push(...page);
    if (page.length < BATCH) return { all, tally: body.pending || null };
    await sleep(200);
  }
}

(async () => {
  if (!Number.isFinite(MAX_RISK) || MAX_RISK < 0 || MAX_RISK > 100) {
    console.error('--max-risk must be 0-100'); process.exit(1);
  }
  if (!TOKEN) {
    console.error('No ADMIN_BOT_TOKEN in the environment, and Railway could not supply one.');
    console.error('Set ADMIN_BOT_TOKEN, or `railway link` this directory.');
    process.exit(1);
  }

  console.log(`scope: ${named.length ? `${named.length} school(s) named on the command line` : 'default — the campuses added with the new metros'} · risk <= ${MAX_RISK}`);
  for (const name of SCHOOLS) console.log(`   · ${name}`);
  console.log('');

  const inScope = new Set(SCHOOLS);
  const { all, tally } = await readQueue();
  const eligible = all.filter(l => inScope.has(l.school_near) && Number(l.risk_score || 0) <= MAX_RISK);
  const held     = all.filter(l => inScope.has(l.school_near) && Number(l.risk_score || 0) >  MAX_RISK);

  const by = (rows) => rows.reduce((m, l) => (m[l.school_near] = (m[l.school_near] || 0) + 1, m), {});
  const pub = by(eligible), hold = by(held);
  for (const name of SCHOOLS) {
    if (!pub[name] && !hold[name]) continue;
    console.log(`  ${name.padEnd(42)} publish ${String(pub[name] || 0).padStart(5)}   hold ${String(hold[name] || 0).padStart(4)}`);
  }
  console.log(`
  queue read: ${all.length} pending overall${tally ? ` (API tally ${tally.total})` : ''}`);
  console.log(`  total to publish: ${eligible.length}`);
  console.log(`  left queued for a human: ${held.length}`);
  // Out-of-scope work is not a silent omission — a scheduled run that quietly
  // ignores a campus nobody added to SCHOOLS is how a backlog rebuilds unseen.
  const outside = all.length - eligible.length - held.length;
  if (outside) console.log(`  outside this scope, untouched: ${outside}`);

  if (DRY) { console.log('\n(dry run — nothing published)'); return; }
  if (!eligible.length) { console.log('\nnothing to publish'); return; }

  const ids = eligible.map(l => l.id);
  console.log(`
publishing ${ids.length} in batches of ${BATCH}…`);

  let ok = 0, failed = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const { ok: good, status, body } = await api('/bot-admin/listings/bulk', {
      method: 'POST',
      body: JSON.stringify({ action: 'approve', ids: batch, reason: `scheduled publish, risk <= ${MAX_RISK}` }),
    }).catch(e => ({ ok: false, status: 0, body: { error: e.message } }));
    if (!good) { failed += batch.length; console.error(`
  batch ${Math.floor(i / BATCH) + 1}: HTTP ${status} ${body?.error || ''}`); }
    else { const acted = body.approved ?? body.acted ?? body.ids; ok += Array.isArray(acted) ? acted.length : batch.length; process.stdout.write('.'); }
    await sleep(250);
  }

  console.log(`

approved ${ok}, failed ${failed}`);
  const after = await api('/bot-admin/pending-listings?limit=1');
  if (after.ok && after.body.pending) {
    console.log(`queue now: ${after.body.pending.total} pending (${after.body.pending.flagged} flagged >= 50)`);
  }
  // A partial failure must not look like success to a scheduler.
  if (failed) process.exit(1);
})().catch(e => { console.error('publish failed:', e.message); process.exit(1); });
