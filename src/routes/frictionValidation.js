/**
 * GET /admin/friction-validation — Outcome-Learning Loop C
 *
 * "For each FrictionCategory, what share of flagged pairs reported that friction
 * as real? Use it to tune each detector's severity/firing threshold, and to
 * retire detectors that don't predict." (docs/specs/outcome-learning.md §1)
 *
 * This is section 3 of the pasted `haveniqPatchesBatch1.js` bundle, extracted
 * and CORRECTED. The other two sections of that bundle were dropped: /circle/me
 * and /conflict-pulse/:matchId are already live (server.js) and read the real
 * schema — the bundle's copies duplicated one and 500'd the other (wrong table/
 * columns). Only this route was net-new.
 *
 * Corrections vs the paste:
 *   • requireAdmin → requireFounder. There is NO requireAdmin export in this
 *     repo; importing it yields undefined, and router.get(...,undefined,...)
 *     throws at module load — the server would not boot. requireFounder is the
 *     real founder-only gate every other /admin + /ops route uses.
 *   • column interpolation is allowlisted (defence-in-depth; the two call sites
 *     already pass literals).
 *
 * DATA STATE (verified 2026-08-07): match_outcomes.details is stored verbatim
 * (sanitizeDetails spreads {...details}; only `note` is redacted), so the keys
 * below WILL persist once the app's check-in flow emits them. It does not yet —
 * so this route is INERT and returns empty aggregates until that build ships and
 * pairs answer check-ins again. No migration needed: it reads existing tables.
 *
 * Nothing consumes this yet — it's an internal tuning surface for the detector
 * thresholds in the app's services/matchReasons.ts, not a user-facing screen.
 */
const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { requireFounder } = require('../middleware/requireFounder');

const router = express.Router();

// Keep in lockstep with the app's utils/cohortGate.ts MIN_COHORT_SAMPLE — the
// same "we'd rather show nothing than a number we haven't earned" rail. Never
// publish a rate below real evidence.
const MIN_COHORT_SAMPLE = 30;

// The only JSONB keys this route is allowed to group by. `column` is
// interpolated into SQL (JSONB key names can't be bound as $-params), so it is
// hard-allowlisted here — the two call sites pass literals, but this guarantees
// no caller can ever route arbitrary text into the query.
const GROUPABLE = new Set(['predictedFrictionCategory', 'predictedFrictionId']);

async function aggregateFriction(column) {
  if (!GROUPABLE.has(column)) throw new Error(`friction-validation: refusing to group by ${column}`);

  const { rows } = await pool.query(
    `SELECT
       details->>'${column}'                                             AS key,
       count(*)                                                          AS n,
       count(*) FILTER (WHERE details->>'frictionConfirmed' = 'yes')     AS confirmed_n,
       count(*) FILTER (WHERE details->>'frictionConfirmed' IS NOT NULL) AS confirmed_reported_n,
       count(*) FILTER (WHERE details->>'stressStretch' = 'clashed')     AS clashed_n,
       count(*) FILTER (WHERE details->>'stressStretch' IS NOT NULL)     AS stress_reported_n,
       count(*) FILTER (WHERE outcome = 'decided_not_to_continue')       AS dissolved_n,
       avg((details->>'rating')::numeric)
         FILTER (WHERE details->>'rating' IS NOT NULL)                   AS avg_rating
     FROM match_outcomes
     WHERE details->>'${column}' IS NOT NULL
     GROUP BY details->>'${column}'
     ORDER BY n DESC`,
  );

  return rows.map((r) => {
    const n = Number(r.n);
    const publishable = n >= MIN_COHORT_SAMPLE;
    return {
      key:        r.key,
      sampleSize: n,
      publishable,
      // PRIMARY signal — the user's own direct yes/no ("your forecast flagged
      // X — did that happen?"). Gated on its OWN reported count, not `n`:
      // frictionConfirmed is null on rows answered before it shipped or with no
      // predicted friction to ask about, so diluting against `n` would
      // understate it forever.
      confirmedRate: publishable && Number(r.confirmed_reported_n) >= MIN_COHORT_SAMPLE
        ? Number(r.confirmed_n) / Number(r.confirmed_reported_n)
        : null,
      // SECONDARY corroboration — proxies, not direct reports.
      clashedRate: publishable && Number(r.stress_reported_n) > 0
        ? Number(r.clashed_n) / Number(r.stress_reported_n)
        : null,
      dissolvedRate: publishable ? Number(r.dissolved_n) / n : null,
      avgRating:     publishable && r.avg_rating != null ? Number(r.avg_rating) : null,
    };
  });
}

// Two grains, same MIN_COHORT_SAMPLE floor: byCategory (coarser, clears the
// floor faster) and byDetector (finer — compare detectors within a category and
// retire the ones that don't predict).
router.get('/admin/friction-validation', requireAuth, requireFounder, async (req, res) => {
  try {
    const [byCategory, byDetector] = await Promise.all([
      aggregateFriction('predictedFrictionCategory'),
      aggregateFriction('predictedFrictionId'),
    ]);
    res.json({ ok: true, byCategory, byDetector });
  } catch (err) {
    console.error('[friction-validation] GET / failed', err.message);
    // Fail closed — never fabricate a rate on error.
    res.status(500).json({ ok: false, byCategory: [], byDetector: [] });
  }
});

module.exports = router;
