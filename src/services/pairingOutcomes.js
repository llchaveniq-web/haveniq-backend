// ── Pairing outcomes recorder (v8 scaffolding, 2026-06-24) ──────────────────
//
// Records the per-pair funnel — connect → message → mutual match → met →
// moved-in — plus failure signals (room change, block, ghost) into the
// pairing_outcomes table (see db/migrate_missing.sql). Purpose: a later
// per-school weight-learning step back-solves which quiz dimensions actually
// predict a successful cohabitation and retunes scoring.js QUESTION_POINTS from
// real outcomes instead of priors.
//
// Best-effort and NON-BLOCKING by contract: every call is fire-and-forget with
// its own try/catch, so an outcome-logging failure can never break the user
// path (connect/message/accept must always succeed regardless).
const pool = require('../db/pool');

// event name → the timestamp column it stamps. Whitelist — the value is
// interpolated into SQL, so it must never come from user input.
const EVENT_COLUMN = {
  connect:     'connected_at',
  message:     'first_message_at',
  match:       'matched_at',     // mutual accept
  met:         'met_at',
  moved_in:    'moved_in_at',
  room_change: 'room_change_at',
  block:       'blocked_at',
  ghost:       'ghosted_at',
};

/**
 * Stamp a funnel event for a pair (idempotent per stage — first occurrence
 * wins, so re-firing 'message' on every message keeps the FIRST timestamp).
 *
 * @param {string} u1, u2 — the two user ids (any order; canonicalized here)
 * @param {string} event  — one of EVENT_COLUMN's keys
 * @param {object} [meta]  — { school, score } snapshotted at connect time
 */
async function recordPairingEvent(u1, u2, event, meta = {}) {
  const col = EVENT_COLUMN[event];
  if (!col || !u1 || !u2 || String(u1) === String(u2)) return;
  const [a, b] = String(u1) < String(u2) ? [u1, u2] : [u2, u1];
  const school = meta.school ?? null;
  const score  = Number.isFinite(meta.score) ? Math.round(meta.score) : null;
  try {
    await pool.query(
      `INSERT INTO pairing_outcomes (user_a, user_b, school, score_at_match, ${col}, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (user_a, user_b) DO UPDATE
         SET ${col}         = COALESCE(pairing_outcomes.${col}, NOW()),
             school         = COALESCE(pairing_outcomes.school, EXCLUDED.school),
             score_at_match = COALESCE(pairing_outcomes.score_at_match, EXCLUDED.score_at_match),
             updated_at     = NOW()`,
      [a, b, school, score],
    );
  } catch (err) {
    console.error('[pairing_outcomes] record failed:', err.message);
  }
}

module.exports = { recordPairingEvent };
