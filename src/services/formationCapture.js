'use strict';
// Formation-time signal capture — LAUNCH-CRITICAL training data.
//
// When a pair is FORMED (match_lifecycle stage:'formed'), freeze BOTH users'
// full signal vectors keyed to the pair, WRITE-ONCE. This is the training anchor
// the outcome-learning loop learns against later; if we don't capture it from
// user #1, it's gone forever (answers/drift/text drift over time). This is a
// pure v10 SIDE CHANNEL — it reads nothing back into scoring; matching is
// unchanged. The fusion/scoring/validation loop comes AFTER the first cohort
// produces outcomes.
//
// Every channel starts at ZERO WEIGHT and must earn it against real outcomes —
// including latency/voice/vouches, which the research found unsupported. They
// are captured here (banked), NOT scored.

const { buildServeFeatures } = require('./pairingOutcomes');

const r3  = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const int = (x) => (Number.isFinite(Number(x)) ? Math.round(Number(x)) : 0);
const hasVoice = (v) => (Array.isArray(v) ? (v.length > 0 ? 1 : 0) : (v ? 1 : 0));

/**
 * PURE: assemble the frozen vector from already-loaded per-user signals.
 * Shape: { v, scoreAtMatch, pair:{q,vel?,conv?,llm?}, channels:{latency,voice,vouches} }
 * `pair` is the exact v10 serve-feature shape (scored channels); `channels` are
 * the zero-weight extras (per-user [a,b] pairs), banked for the later loop.
 */
function buildFrozenVector(input = {}) {
  const {
    aAnswers, bAnswers, aDrift = null, bDrift = null, aLlm = null, bLlm = null,
    aVoice = null, bVoice = null, aVouches = 0, bVouches = 0,
    aLatency = null, bLatency = null, scoreAtMatch = null, predictedTier = null,
  } = input;
  return {
    v: 1,
    // The v10 prediction shown at match — same vocabulary as the outcome path
    // (predictedScore/predictedTier), so the loop can join freeze ↔ outcome.
    scoreAtMatch: Number.isFinite(scoreAtMatch) ? Math.round(scoreAtMatch) : null,
    predictedTier: (typeof predictedTier === 'string' && predictedTier) ? predictedTier : null,
    // Scored channels (v10 shape): answer pairs, drift trajectory, text constructs.
    pair: buildServeFeatures(aAnswers, bAnswers, aDrift, bDrift, aLlm, bLlm),
    // ZERO-WEIGHT channels — captured, never scored, λ=0 until they earn it.
    channels: {
      latency: [r3(aLatency), r3(bLatency)],       // deliberativeness 0..1 (null until the loader lands)
      voice:   [hasVoice(aVoice), hasVoice(bVoice)], // 1 = has voice answers on file
      vouches: [int(aVouches), int(bVouches)],       // approved past-roommate vouch count
    },
  };
}

/**
 * Load both users' signals from durable stores and FREEZE, keyed to the pair.
 * Idempotent — first 'formed' wins; a re-fire skips the loads and no-ops. The
 * frozen_features write is COALESCE-guarded so a race can never overwrite it.
 * Best-effort by contract: a failure here must never break the telemetry batch.
 *
 * @param {string} u1,u2 — the two user ids (any order; canonicalized to a<b)
 * @param {object} [meta] — { predictedScore, predictedTier } from the emit (same
 *   vocabulary as the outcome path). `school` is NOT taken from the client — it's
 *   derived server-side from the users' own profiles (a client can't spoof it).
 */
async function freezeFormationVector(u1, u2, meta = {}) {
  if (!u1 || !u2 || String(u1) === String(u2)) return;
  const [a, b] = String(u1) < String(u2) ? [String(u1), String(u2)] : [String(u2), String(u1)];
  const pool = require('../db/pool');
  try {
    // Write-once: if already frozen, skip the (expensive) signal loads entirely.
    const chk = await pool.query(
      'SELECT frozen_features IS NOT NULL AS frozen FROM pairing_outcomes WHERE user_a = $1 AND user_b = $2',
      [a, b]);
    if (chk.rows[0] && chk.rows[0].frozen) return;

    const { loadDrift } = require('./pulseDrift');
    const { loadFeatures } = require('./textInsight');
    const [ansRes, driftMap, llmMap, vouchRes, usersRes] = await Promise.all([
      pool.query('SELECT user_id, answers, voice_answers FROM quiz_answers WHERE user_id = ANY($1::uuid[])', [[a, b]]),
      loadDrift([a, b]),
      loadFeatures([a, b]),
      pool.query(
        "SELECT user_id, COUNT(*)::int AS n FROM vouches WHERE user_id = ANY($1::uuid[]) AND status = 'approved' GROUP BY user_id",
        [[a, b]]).catch(() => ({ rows: [] })),
      // school is SERVER-DERIVED from the users' own profiles — never trusted
      // from the client (a client-sent campus could be spoofed).
      pool.query('SELECT id, school FROM users WHERE id = ANY($1::uuid[])', [[a, b]]).catch(() => ({ rows: [] })),
    ]);
    const ans = {}, voice = {}, vouch = {}, schoolBy = {};
    for (const row of ansRes.rows) { ans[String(row.user_id)] = row.answers || {}; voice[String(row.user_id)] = row.voice_answers || null; }
    for (const row of vouchRes.rows) vouch[String(row.user_id)] = row.n;
    for (const row of usersRes.rows) schoolBy[String(row.id)] = row.school || null;
    // Canonical campus = the shared school when both match, else user_a's (a<b).
    const derivedSchool = (schoolBy[a] && schoolBy[a] === schoolBy[b]) ? schoolBy[a] : (schoolBy[a] || schoolBy[b] || null);

    const frozen = buildFrozenVector({
      aAnswers: ans[a], bAnswers: ans[b],
      aDrift: driftMap[a], bDrift: driftMap[b],
      aLlm: llmMap[a], bLlm: llmMap[b],
      aVoice: voice[a], bVoice: voice[b],
      aVouches: vouch[a] || 0, bVouches: vouch[b] || 0,
      // latency (deliberativeness) lives in behavioral_event payloads — a
      // zero-weight channel, captured as null until a per-user loader lands.
      aLatency: null, bLatency: null,
      scoreAtMatch: Number.isFinite(meta.predictedScore) ? meta.predictedScore : null,
      predictedTier: typeof meta.predictedTier === 'string' ? meta.predictedTier : null,
    });

    await pool.query(
      `INSERT INTO pairing_outcomes (user_a, user_b, school, score_at_match, formed_at, frozen_features, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), $5, NOW())
       ON CONFLICT (user_a, user_b) DO UPDATE
         SET formed_at       = COALESCE(pairing_outcomes.formed_at, NOW()),
             frozen_features = COALESCE(pairing_outcomes.frozen_features, EXCLUDED.frozen_features),
             school          = COALESCE(pairing_outcomes.school, EXCLUDED.school),
             score_at_match  = COALESCE(pairing_outcomes.score_at_match, EXCLUDED.score_at_match),
             updated_at      = NOW()`,
      [a, b, derivedSchool, Number.isFinite(meta.predictedScore) ? int(meta.predictedScore) : null, JSON.stringify(frozen)]);
  } catch (e) {
    console.error('[formationCapture] freeze failed:', e.message);
  }
}

module.exports = { buildFrozenVector, freezeFormationVector };
