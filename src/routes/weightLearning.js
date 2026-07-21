// ═══════════════════════════════════════════════════════════════════════════
//  Outcome-learning endpoints — Phases 2–4.
//
//   Public (aggregate, honest, higher bar than in-app):
//     GET  /match-outcomes/proof              → landing/marketing headline stat
//
//   Founder-gated (the HUMAN commit lever):
//     POST /weight-proposals/:id/approve      → log + emit weights to commit
//     POST /weight-proposals/:id/reject
//
//   Bot-gated (cron + ops):
//     POST /bot-admin/weight-analyst/run      → compute + enqueue proposals
//     GET  /bot-admin/weight-analyst/preview  → illustrative (no enqueue)
//     GET  /bot-admin/weight-proposals        → the review queue (pending)
//     GET  /bot-admin/weight-change-log       → audit trail of approved changes
//     GET  /bot-admin/calibration-metrics     → Brier / AUC / monotonicity + history
//
//  Nothing here mutates the live model. Approval only LOGS + returns the weight
//  map for a human to commit into scoring.js + quizStore.ts. See OUTCOME_LEARNING_PLAN.md.
// ═══════════════════════════════════════════════════════════════════════════

const router = require('express').Router();
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { requireFounder } = require('../middleware/requireFounder');
const store = require('../services/weightProposalStore');
const analyst = require('../services/weightAnalyst');
const metrics = require('../services/calibrationMetrics');
const snapshots = require('../services/learningSnapshots');
const { computeCalibration, isAnswered, isSuccess, ratingOf } = require('./matchOutcomes')._calibration;

// Bot token gate — same inline fallback used by routes/matchOutcomes.js
// (there is no middleware/botAuth module).
const { requireBotToken } = (() => {
  try { return require('../middleware/botAuth'); }
  catch {
    return {
      requireBotToken: (req, res, next) => {
        const tok = process.env.ADMIN_BOT_TOKEN;
        if (!tok) return res.status(503).json({ error: 'bot auth disabled' });
        const auth = req.headers.authorization || '';
        const got = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        if (got !== tok) return res.status(401).json({ error: 'Invalid bot token.' });
        next();
      },
    };
  }
})();

// Read every answered outcome carrying a predicted score, and derive both the
// calibration bands and the per-outcome (p, y) points for Brier/AUC. Shared by
// the proof + metrics endpoints. Success mirrors the calibration definition.
async function readCalibration() {
  // Prefer the promoted predicted_score column, fall back to the JSONB — same
  // read as /match-outcomes/calibration, so the proof headline and the report
  // can never be computed over different row sets.
  const { rows } = await pool.query(`
    SELECT COALESCE(predicted_score::text, details->>'predictedScore') AS predicted_score,
           details->>'stage'          AS stage,
           details->>'answer'         AS answer,
           details->>'rating'         AS rating
      FROM match_outcomes
     WHERE COALESCE(predicted_score::text, details->>'predictedScore') ~ '^[0-9.]+$'`);
  const mapped = rows.map((r) => ({
    predictedScore: r.predicted_score, stage: r.stage, answer: r.answer, rating: r.rating,
  }));
  const calibration = computeCalibration(mapped);
  // Points for Brier/AUC: p = predicted/100, y = success(1/0), answered only.
  const points = [];
  for (const r of mapped) {
    // Shared with computeCalibration: a missing rating is SQL NULL, and
    // Number(null) === 0 would score it as answered-and-failed, pushing a
    // fabricated y=0 into the Brier/AUC points behind the PUBLIC proof headline.
    const rating = ratingOf(r.rating);
    const item = { stage: r.stage, answer: r.answer, rating };
    if (!isAnswered(item)) continue;
    const score = Number(r.predictedScore);
    if (!Number.isFinite(score)) continue;
    points.push({ p: Math.max(0, Math.min(1, score / 100)), y: isSuccess(item) ? 1 : 0 });
  }
  return { calibration, points };
}

// ── PUBLIC: honest landing/marketing headline ──────────────────────────────
// No auth: it's aggregate-only and self-censoring. Returns the gated Nx claim
// or { ok:false } — never raw individual data, never a fabricated number.
router.get('/match-outcomes/proof', async (req, res) => {
  try {
    const { calibration } = await readCalibration();
    if (!calibration.ok) return res.json({ ok: false });
    const headline = metrics.publicHeadline(calibration);
    return res.json(headline.ok ? headline : { ok: false });
  } catch (err) {
    console.error('[proof] failed:', err.message);
    return res.json({ ok: false }); // honest degrade → "still gathering"
  }
});

// ── BOT: run the analyst (compute + enqueue). Non-overlapping via the caller. ─
router.post('/bot-admin/weight-analyst/run', requireBotToken, async (req, res) => {
  try {
    const result = await analyst.runAnalyst({ enqueue: true });
    return res.json({ ...result, ranAt: new Date().toISOString() });
  } catch (err) {
    console.error('[weight-analyst run] failed:', err);
    return res.status(500).json({ error: 'analyst run failed' });
  }
});

// ── BOT: illustrative proposals without enqueuing (inspect below readiness) ──
router.get('/bot-admin/weight-analyst/preview', requireBotToken, async (req, res) => {
  try {
    const { global, schools, decidedTotal } = await analyst.computeProposals();
    return res.json({ decidedTotal, global, schools });
  } catch (err) {
    console.error('[weight-analyst preview] failed:', err);
    return res.status(500).json({ error: 'preview failed' });
  }
});

// ── BOT: the review queue ───────────────────────────────────────────────────
router.get('/bot-admin/weight-proposals', requireBotToken, async (req, res) => {
  const pending = await store.listPending(req.query.scope);
  return res.json({ count: pending.length, proposals: pending });
});

router.get('/bot-admin/weight-change-log', requireBotToken, async (req, res) => {
  const log = await store.changeLog();
  return res.json({ count: log.length, changes: log });
});

// ── BOT: Brier / AUC / monotonicity + recent history ───────────────────────
router.get('/bot-admin/calibration-metrics', requireBotToken, async (req, res) => {
  try {
    const { calibration, points } = await readCalibration();
    const brier = metrics.brierScore(points);
    const auc = metrics.auc(points);
    const monotonic = calibration.ok ? metrics.isMonotonic(calibration.bands) : null;
    const headline = calibration.ok ? metrics.publicHeadline(calibration) : { ok: false };
    return res.json({
      totalSample: calibration.ok ? calibration.totalSample : 0,
      brier, auc, monotonic,
      headlineMultiple: headline.ok ? headline.multiple : null,
      bands: calibration.ok ? calibration.bands : [],
      history: await snapshots.recent(),
    });
  } catch (err) {
    console.error('[calibration-metrics] failed:', err);
    return res.status(500).json({ error: 'metrics failed' });
  }
});

// ── FOUNDER (human gate): approve / reject a proposal ───────────────────────
router.post('/weight-proposals/:id/approve', requireAuth, requireFounder, async (req, res) => {
  const result = await store.approve(req.params.id, {
    reviewerId: req.user.id, toVersion: (req.body && req.body.toVersion) || null,
  });
  if (!result.ok) {
    const code = result.reason === 'not_found' ? 404 : 409;
    return res.status(code).json(result);
  }
  return res.json(result);
});

router.post('/weight-proposals/:id/reject', requireAuth, requireFounder, async (req, res) => {
  const result = await store.reject(req.params.id, {
    reviewerId: req.user.id, note: (req.body && req.body.note) || null,
  });
  return res.status(result.ok ? 200 : 404).json(result);
});

// Exposed for a scheduled recompute to snapshot metrics (server.js).
router._readCalibration = readCalibration;

module.exports = router;
