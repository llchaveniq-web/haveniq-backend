/**
 * Conflict Pulse — the roommate "how's it going?" read stream.
 *
 * One row per client-emitted `conflict_pulse`: a student privately logs how a
 * shared-living topic feels right now (level 0–2) and whether they've raised it.
 * The counterpart's app reads these back (GET /conflict-pulse/:matchId) to power
 * the early-warning screen.
 *
 * Same longitudinal-family shape as services/pairEvents.js: written from the
 * /telemetry/batch side-channel, NOT part of the generic telemetry_events blob,
 * and keyed on TEXT ids (no FK) so an unlinked roommate never gets rejected.
 * The client event id is the primary key, so a retried batch is idempotent.
 */

const pool = require('../db/pool');

const TYPE = 'conflict_pulse';
const MAX_TOPIC = 64;

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) =>
  (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/**
 * Validate + shape one client event into a DB row, or return null to drop it.
 * Payload from the frontend (stores/conflictPulseStore.ts): { matchId, topic,
 * level, raised, at }.
 */
function normalize(evt, userId) {
  if (!evt || typeof evt.id !== 'string' || !evt.id) return null;
  const p = evt.payload;
  if (!isPlainObject(p)) return null;

  // The roommate this read is about. A read about yourself is malformed.
  const matchId = str(p.matchId, 128);
  if (!matchId) return null;
  if (matchId === String(userId)) return null;

  const topic = str(p.topic, MAX_TOPIC);
  if (!topic) return null;

  // level is the 0–2 comfort read the app ships. Anything outside that is
  // out-of-contract shape → drop (don't store noise the early-warning UI can't
  // interpret), mirroring pairEvents' strict-shape normalize.
  const level = Number(p.level);
  if (!Number.isInteger(level) || level < 0 || level > 2) return null;

  // Client event clock (ms). Orders the timeline; without it the row can't take
  // its place in the sequence.
  const at = Number(p.at);
  if (!Number.isFinite(at)) return null;

  return {
    id:      evt.id,
    userId:  String(userId),
    matchId,
    topic,
    level,
    raised:  p.raised === true,
    at:      Math.trunc(at),
  };
}

// Self-healing table create, cached per process (same shape as pair_events and
// the other self-migrating telemetry tables). migrate_missing.sql creates this
// on boot; this guard means a fresh DB or skipped migration loses no events.
let tableReady = false;
async function ensureTable(db = pool) {
  if (tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS conflict_pulses (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      match_id   TEXT NOT NULL,
      topic      TEXT NOT NULL,
      level      SMALLINT NOT NULL,
      raised     BOOLEAN NOT NULL DEFAULT FALSE,
      at         BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await db.query(
    'CREATE INDEX IF NOT EXISTS idx_conflict_pulses_user_match ON conflict_pulses (user_id, match_id)',
  );
  tableReady = true;
}

/**
 * Persist the conflict_pulse events in one telemetry batch. Returns
 * {stored, dropped}. Dedups on the client event id, so retries are idempotent.
 */
async function persistBatch(events, userId, db = pool) {
  const seen = (Array.isArray(events) ? events : []).filter(e => e && e.type === TYPE);
  const rows = seen.map(e => normalize(e, userId)).filter(Boolean);
  if (!rows.length) return { stored: 0, dropped: seen.length };

  await ensureTable(db);
  let stored = 0;
  for (const r of rows) {
    const { rowCount } = await db.query(
      `INSERT INTO conflict_pulses (id, user_id, match_id, topic, level, raised, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO NOTHING`,
      [r.id, r.userId, r.matchId, r.topic, r.level, r.raised, r.at],
    );
    stored += rowCount;
  }
  return { stored, dropped: seen.length - rows.length };
}

/**
 * The counterpart's OWN conflict_pulses rows about ME, within the freshness
 * window, oldest first. `counterpartId` = user_id (who logged the read);
 * `myId` = match_id (the read is about me). `at` (BIGINT) comes back from
 * node-postgres as a string, so cast it to a number for the client.
 */
async function freshReads(counterpartId, myId, freshDays, db = pool) {
  await ensureTable(db);
  const { rows } = await db.query(
    `SELECT topic, level, raised, at
       FROM conflict_pulses
      WHERE user_id = $1
        AND match_id = $2
        AND created_at >= NOW() - ($3 || ' days')::interval
      ORDER BY at ASC`,
    [String(counterpartId), String(myId), freshDays],
  );
  return rows.map(r => ({ topic: r.topic, level: r.level, raised: r.raised, at: Number(r.at) }));
}

module.exports = {
  TYPE, normalize, ensureTable, persistBatch, freshReads,
  _resetTableReady: () => { tableReady = false; },   // tests only
};
