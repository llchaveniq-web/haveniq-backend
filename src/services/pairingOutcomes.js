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
// pool is lazy-required inside the DB functions only, so the pure helper
// (buildServeFeatures) is importable — and unit-testable — without `pg`.
const { QUESTION_POINTS, OPTION_COUNTS } = require('./scoring');

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
  pass:        'passed_at',      // viewer skipped the card (no connect)
  decline:     'declined_at',    // recipient rejected a connect request
};

// ── Serve-time feature snapshot ─────────────────────────────────────────────
// Build the per-question normalized value pairs for a viewer×candidate at the
// moment a feed is served. Each scored question becomes [viewerNorm, candNorm]
// in [0,1] (option index / (optionCount-1)). This is the raw, model-agnostic
// signal the interaction model trains on (it can derive dist/mean/min/max/prod
// from these pairs). Only questions BOTH answered are included. Captured at
// serve time on purpose — answers can change later; the training set must
// reflect what was actually shown. Returns { q: { "<qid>": [a, b], … } }.
const SCORED_QIDS = Object.keys(QUESTION_POINTS);
function answerIndex(answers, qid) {
  if (!answers || typeof answers !== 'object') return null;
  const v = answers[qid];
  const num = (x) => {
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
    return null;
  };
  let n = num(v);
  if (n === null && v && typeof v === 'object') { n = num(v.index); if (n === null) n = num(v.value); }
  return n;
}
// Optional drift maps (deep-matching #6): { "<qid>": { velocity, trend, sampleSize } }
// per user. When present we ALSO snapshot, per question, the normalized effective
// velocities and the convergence rate AT SERVE TIME — the trajectory training
// signal the #6 gate needs. Absent ⇒ only `q` is captured (today's behavior).
function buildServeFeatures(viewerAnswers, candidateAnswers, viewerDrift = null, candidateDrift = null, viewerLlm = null, candidateLlm = null) {
  const { effectiveVelocity, convergence } = require('./trajectory');
  const q = {}, vel = {}, conv = {};
  for (const qid of SCORED_QIDS) {
    const a = answerIndex(viewerAnswers, qid);
    const b = answerIndex(candidateAnswers, qid);
    if (a === null || b === null) continue;          // only questions both answered
    const den = Math.max(1, (OPTION_COUNTS[qid] || 4) - 1);
    const r3 = (x) => Math.round(x * 1000) / 1000;
    q[qid] = [r3(a / den), r3(b / den)];

    const dA = viewerDrift && viewerDrift[qid];
    const dB = candidateDrift && candidateDrift[qid];
    if (dA || dB) {
      const veA = effectiveVelocity(dA), veB = effectiveVelocity(dB);
      if (veA !== 0 || veB !== 0) {
        vel[qid] = [r3(veA / den), r3(veB / den)];     // normalized effective velocity / 30d
        conv[qid] = r3(convergence(a, b, dA, dB, den)); // +closing / −widening / 0
      }
    }
  }
  // Deep-matching #5: snapshot the two users' LLM text-insight constructs (both
  // present) at serve time, so the gate has [cA, cB] pairs to certify against.
  const llm = {};
  if (viewerLlm && candidateLlm && typeof viewerLlm === 'object' && typeof candidateLlm === 'object') {
    for (const k of Object.keys(viewerLlm)) {
      const cA = Number(viewerLlm[k]), cB = Number(candidateLlm[k]);
      if (Number.isFinite(cA) && Number.isFinite(cB)) llm[k] = [Math.round(cA * 1000) / 1000, Math.round(cB * 1000) / 1000];
    }
  }
  const out = { q };
  if (Object.keys(vel).length) { out.vel = vel; out.conv = conv; }
  if (Object.keys(llm).length) out.llm = llm;
  return out;
}

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
    const pool = require('../db/pool');
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

/**
 * Log feed impressions for one serve: upsert one pairing_outcomes row per
 * surfaced candidate, snapshotting the score shown + the serve-time features.
 * Re-serving a pair refreshes the snapshot and bumps impression_count; it never
 * overwrites first_served_at or any decision/outcome timestamp. Pure logging —
 * changes no score. Best-effort / non-blocking by contract.
 *
 * @param {string} viewerId — the user whose feed this is
 * @param {Array<{candidateId:string, score:number, features:object, school?:string}>} items
 */
async function recordFeedImpressions(viewerId, items) {
  if (!viewerId || !Array.isArray(items) || items.length === 0) return;
  const rows = [];
  for (const it of items) {
    const cand = it && it.candidateId;
    if (!cand || String(cand) === String(viewerId)) continue;
    const [a, b] = String(viewerId) < String(cand) ? [viewerId, cand] : [cand, viewerId];
    const score = Number.isFinite(it.score) ? Math.round(it.score) : null;
    rows.push([a, b, it.school ?? null, score, it.features ? JSON.stringify(it.features) : null]);
  }
  if (rows.length === 0) return;

  // 5 params per row; first/last_served_at + impression_count are SQL literals.
  const COLS = 5;
  const values = rows
    .map((_, i) => {
      const o = i * COLS;
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}::jsonb, NOW(), NOW(), 1)`;
    })
    .join(', ');
  try {
    const pool = require('../db/pool');
    await pool.query(
      `INSERT INTO pairing_outcomes
         (user_a, user_b, school, score_at_serve, features, first_served_at, last_served_at, impression_count)
       VALUES ${values}
       ON CONFLICT (user_a, user_b) DO UPDATE
         SET impression_count = pairing_outcomes.impression_count + 1,
             last_served_at   = NOW(),
             score_at_serve   = EXCLUDED.score_at_serve,
             features         = EXCLUDED.features,
             first_served_at  = COALESCE(pairing_outcomes.first_served_at, NOW()),
             school           = COALESCE(pairing_outcomes.school, EXCLUDED.school),
             updated_at       = NOW()`,
      rows.flat(),
    );
  } catch (err) {
    console.error('[pairing_outcomes] impression log failed:', err.message);
  }
}

module.exports = { recordPairingEvent, recordFeedImpressions, buildServeFeatures };
