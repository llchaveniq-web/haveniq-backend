/**
 * Longitudinal pair telemetry — the ground-truth roommate dataset.
 *
 * One row per client-emitted `pair_event`: signal → intervention → outcome, per
 * pair, over time. The app already emits these on the normal telemetry batch and
 * can export them locally; this is where they become a dataset a cohort query
 * can actually run against.
 *
 * The dataset's value is its HONESTY. Nothing here invents, infers, or backfills
 * an event: a pairing that never reported an outcome stays missing, because a
 * fabricated outcome would silently corrupt the one question the data exists to
 * answer (did the intervention help, and did the pair stay?).
 */

const crypto = require('crypto');
const pool = require('../db/pool');

// The analytical axis. Strict — an event with an unrecognized `kind` can't be
// placed in the signal→intervention→outcome chain, so it has no analytical
// meaning and is dropped rather than stored as noise.
const KINDS = new Set(['signal', 'intervention', 'outcome']);

// The vocabulary the app ships today. Deliberately NOT enforced: if the app adds
// a subtype before the backend learns about it, rejecting the event would punch
// a silent, unrecoverable hole in a longitudinal record — the worst failure mode
// for this dataset. Unknown subtypes are stored and surfaced by the export's
// `subtypes` summary, so vocabulary drift is visible instead of invisible.
const KNOWN_SUBTYPES = new Set([
  // signal
  'pulse', 'early_warning_fired', 'conflict_flagged',
  // intervention
  'nudge_shown', 'repair_opened', 'repair_completed',
  'agreement_made', 'agreement_revisited', 'forecast_viewed',
  // outcome
  'checkin', 'moved_in', 'room_change', 'lease_break', 'ended',
]);

// The two arms of the Level-1 counterfactual. `control` pairs are NOT denied
// help — they keep the standard passive support every pair gets; they just
// don't receive the active nudge/repair coaching. That distinction is what
// makes holding some episodes back ethically defensible, and it is the reason
// the comparison can be run at all.
const ARMS = Object.freeze(['intervention', 'control']);

// The signal that OPENS an episode. Only this subtype mints a new arm; every
// later event in the episode inherits the arm already stored for it.
const EPISODE_OPENER = 'conflict_flagged';

const MAX_STR  = 64;     // topic / subtype
const MAX_META = 2000;   // serialized meta bytes

/**
 * The canonical unordered pairing.
 *
 * Each side emits keyed on the OTHER person: A sends pairId=B, B sends pairId=A.
 * Sorting collapses both into one key so the two halves of the same roommate
 * relationship group together. Derived SERVER-SIDE on insert — never accepted
 * from the client, so one account can't file events under another pair's key.
 */
function pairKeyFor(userId, pairId) {
  return [String(userId), String(pairId)].sort().join(':');
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) =>
  (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/**
 * Validate + shape one client event into a DB row, or return null to drop it.
 * Shape is enforced strictly; vocabulary is not (see KNOWN_SUBTYPES).
 */
function normalize(evt, userId) {
  if (!evt || typeof evt.id !== 'string' || !evt.id) return null;
  const p = evt.payload;
  if (!isPlainObject(p)) return null;

  const pairId = str(p.pairId, 128);
  if (!pairId) return null;
  // A user paired with themselves is malformed, not a relationship. Storing it
  // would create a degenerate "X:X" cohort row.
  if (pairId === String(userId)) return null;

  // `t` is the client's event clock (ms) and orders the timeline. Without a
  // usable one the row can't take its place in the sequence.
  const t = Number(p.t);
  if (!Number.isFinite(t)) return null;

  if (typeof p.kind !== 'string' || !KINDS.has(p.kind)) return null;
  const subtype = str(p.subtype, MAX_STR);
  if (!subtype) return null;

  const value = Number.isFinite(Number(p.value)) && p.value !== null && p.value !== ''
    ? Number(p.value) : null;

  // meta is small structured JSON ({raised}, {outcome}, {warningKind, severity}).
  // A string is refused outright — the contract says never free text, and that's
  // the field a stray note would arrive in.
  let meta = null;
  if (isPlainObject(p.meta)) {
    const s = JSON.stringify(p.meta);
    if (s && s.length <= MAX_META) meta = p.meta;
  }

  return {
    id:      evt.id,
    userId:  String(userId),
    pairId,
    pairKey: pairKeyFor(userId, pairId),
    t:       Math.trunc(t),
    kind:    p.kind,
    subtype,
    topic:   str(p.topic, MAX_STR),
    value,
    meta,
    // Which conflict episode this event belongs to. Client-supplied, because
    // only the client knows which flagged conflict a later nudge relates to.
    episodeId: str(p.episodeId, MAX_STR),
    // `arm` is deliberately NOT read from the payload — see resolveArm(). A
    // client that could name its own arm could put every pair it liked into the
    // intervention group, and the comparison would measure nothing.
  };
}

/**
 * Deterministically assign an arm to an episode.
 *
 * Deterministic on the episode id rather than random: a retried or replayed
 * `conflict_flagged` must resolve to the SAME arm, or a pair could flip from
 * control to intervention part-way through and silently contaminate the
 * comparison. Even 50/50 split on the low bit of a hash.
 */
function assignArm(episodeId) {
  const h = crypto.createHash('sha256').update(String(episodeId)).digest();
  return ARMS[h[0] & 1];
}

/**
 * The arm for an episode: whatever was already stored for it, else a fresh
 * assignment. Every event in an episode therefore carries the same arm, which
 * is what the export groups on.
 */
async function resolveArm(episodeId, db = pool) {
  if (!episodeId) return null;
  const { rows } = await db.query(
    `SELECT arm FROM pair_events
      WHERE episode_id = $1 AND arm IS NOT NULL
      ORDER BY created_at ASC LIMIT 1`,
    [episodeId],
  ).catch(() => ({ rows: [] }));
  return rows[0]?.arm || assignArm(episodeId);
}

/**
 * Is this pair consented to be tracked? The ledger records two real people's
 * conflict, so v1 is an explicitly consented cohort — no row, no tracking.
 * Revoking sets revoked_at, which stops future tracking without deleting the
 * history already gathered while consent was active.
 */
async function hasConsent(pairKey, db = pool) {
  const { rows } = await db.query(
    'SELECT 1 FROM pair_consent WHERE pair_id = $1 AND revoked_at IS NULL LIMIT 1',
    [pairKey],
  ).catch(() => ({ rows: [] }));
  return rows.length > 0;
}

// Self-healing table create, cached per process (same shape as the other
// self-migrating telemetry tables). migrate_missing.sql creates this on boot;
// this guard means a fresh DB or a skipped migration loses no research events.
let tableReady = false;
async function ensureTable(db = pool) {
  if (tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS pair_events (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      pair_id    TEXT NOT NULL,
      pair_key   TEXT NOT NULL,
      t          BIGINT NOT NULL,
      kind       TEXT NOT NULL,
      subtype    TEXT NOT NULL,
      topic      TEXT,
      value      DOUBLE PRECISION,
      meta       JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await db.query('ALTER TABLE pair_events ADD COLUMN IF NOT EXISTS episode_id TEXT');
  await db.query('ALTER TABLE pair_events ADD COLUMN IF NOT EXISTS arm TEXT');
  await db.query(`CREATE TABLE IF NOT EXISTS pair_consent (pair_id TEXT PRIMARY KEY, consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), scope TEXT, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query('CREATE INDEX IF NOT EXISTS idx_pair_events_pair_t ON pair_events (pair_key, t)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_pair_events_t    ON pair_events (t)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_pair_events_user ON pair_events (user_id)');
  tableReady = true;
}

/**
 * Persist the pair_events in one telemetry batch. Returns {stored, dropped}.
 * Dedups on the client event id, so retries are idempotent.
 *
 * Consent is enforced HERE — not at each call site. POST /pairs/:pairId/events
 * (routes/pairs.js) already checks hasConsent() before calling this, but this
 * function is ALSO reached directly from the ordinary telemetry batch
 * (routes/telemetry.js's POST /telemetry/batch), which never checked consent
 * at all — meaning a non-consented pair's conflict data was being persisted
 * (and was then exportable via routes/research.js) through the one path the
 * app actually uses day to day, defeating the "explicitly consented cohort,
 * no row, no tracking" invariant this whole dataset depends on for its
 * ethical basis. Checking it once here, rather than trusting every future
 * caller to remember, is what actually holds that invariant — the same
 * reasoning as reusing this one normalize/persist path in the first place
 * (see routes/pairs.js's own comment: "there is ONE validator and one
 * insert — a second copy would drift").
 */
async function persistBatch(events, userId, db = pool) {
  const rows = (Array.isArray(events) ? events : [])
    .filter(e => e && e.type === 'pair_event')
    .map(e => normalize(e, userId))
    .filter(Boolean);
  const seen = (Array.isArray(events) ? events : []).filter(e => e && e.type === 'pair_event').length;
  if (!rows.length) return { stored: 0, dropped: seen };

  await ensureTable(db);

  // One consent check per DISTINCT pair in the batch, not per event — a
  // batch is capped at 100 events but could still repeat the same pair.
  const consentCache = new Map();
  const consentedRows = [];
  for (const r of rows) {
    if (!consentCache.has(r.pairKey)) {
      consentCache.set(r.pairKey, await hasConsent(r.pairKey, db));
    }
    if (consentCache.get(r.pairKey)) consentedRows.push(r);
  }

  let stored = 0;
  for (const r of consentedRows) {
    const { rowCount } = await db.query(
      `INSERT INTO pair_events (id, user_id, pair_id, pair_key, t, kind, subtype, topic, value, meta, episode_id, arm)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO NOTHING`,
      [r.id, r.userId, r.pairId, r.pairKey, r.t, r.kind, r.subtype, r.topic, r.value,
       r.meta === null ? null : JSON.stringify(r.meta),
       r.episodeId ?? null,
       // Resolved server-side per episode, never taken from the client.
       r.episodeId ? await resolveArm(r.episodeId, db) : null],
    );
    stored += rowCount;
  }
  return { stored, dropped: seen - stored };
}

// `t` is BIGINT, which node-postgres hands back as a STRING. The client's local
// export holds it as a number, and the whole verification step is "these two
// sets match" — so cast it back here rather than shipping a type mismatch.
// Millisecond timestamps are ~1.7e12, far inside Number's exact-integer range.
const toRow = (r) => ({
  id: r.id,
  userId: r.user_id,
  pairId: r.pair_id,
  pairKey: r.pair_key,
  t: Number(r.t),
  kind: r.kind,
  subtype: r.subtype,
  topic: r.topic,
  value: r.value === null ? null : Number(r.value),
  meta: r.meta,
  episodeId: r.episode_id ?? null,
  arm: r.arm ?? null,
  createdAt: r.created_at,
});

/** One pair's full timeline, both sides, ordered by the client clock. */
async function timeline(pairKey, db = pool) {
  await ensureTable(db);
  const { rows } = await db.query(
    `SELECT id, user_id, pair_id, pair_key, t, kind, subtype, topic, value, meta, episode_id, arm, created_at
       FROM pair_events WHERE pair_key = $1 ORDER BY t ASC, created_at ASC`,
    [pairKey],
  );
  return rows.map(toRow);
}

/** Bulk cohort export from a client-clock watermark. */
async function since(sinceMs, limit, db = pool) {
  await ensureTable(db);
  const { rows } = await db.query(
    `SELECT id, user_id, pair_id, pair_key, t, kind, subtype, topic, value, meta, episode_id, arm, created_at
       FROM pair_events WHERE t >= $1 ORDER BY t ASC, created_at ASC LIMIT $2`,
    [sinceMs, limit],
  );
  return rows.map(toRow);
}

module.exports = {
  pairKeyFor, normalize, persistBatch, timeline, since, ensureTable,
  KINDS, KNOWN_SUBTYPES, ARMS,
  assignArm, resolveArm, hasConsent,
  _resetTableReady: () => { tableReady = false; },   // tests only
};
