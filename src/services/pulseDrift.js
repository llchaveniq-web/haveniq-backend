// ─── Pulse-drift loader (deep-matching #6) ──────────────────────────────────
// Reads the LATEST per-question drift snapshot for a set of users from the
// pulse_drift table and returns it grouped for the scorer/serve-logger:
//   { "<userId>": { "<qid>": { velocity, trend, sampleSize } } }
// Best-effort: any failure (table missing during boot, query error) returns {}
// so scoring/logging falls back to snapshot-only — bit-for-bit today.

async function loadDrift(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (ids.length === 0) return {};
  try {
    const pool = require('../db/pool');
    const { rows } = await pool.query(
      `SELECT user_id, question_id, velocity, trend, sample_size
         FROM pulse_drift
        WHERE user_id = ANY($1::uuid[])`,
      [ids],
    );
    const out = {};
    for (const r of rows) {
      const uid = String(r.user_id);
      (out[uid] || (out[uid] = {}))[r.question_id] = {
        velocity: r.velocity != null ? Number(r.velocity) : 0,
        trend: r.trend || null,
        sampleSize: r.sample_size != null ? Number(r.sample_size) : 0,
      };
    }
    return out;
  } catch (e) {
    console.error('[pulseDrift] load failed:', e.message);
    return {};
  }
}

module.exports = { loadDrift };
