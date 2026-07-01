// ═══════════════════════════════════════════════════════════════════════════
//  Ops — self-reporting status surface for the Watch loop.
//
//  GET /ops/health-history (founder-only): the recent /health poll results the
//  monitor recorded, plus the current debounced status. Honest by construction:
//  before the first poll there is no data, so it returns an EMPTY history and a
//  status of 'unknown' — never a fabricated "all green".
// ═══════════════════════════════════════════════════════════════════════════

const router = require('express').Router();
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { requireFounder } = require('../middleware/requireFounder');
const { watcher } = require('../services/healthWatchRunner');
const lifecycle = require('../services/lifecycleSender');
const coverageDiff = require('../services/coverageDiff');
const growthDigest = require('../services/growthDigest');

router.get('/ops/health-history', requireAuth, requireFounder, (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const history = watcher.history(limit);
  res.json({
    status: watcher.status(),   // 'unknown' with observations:0 when nothing polled yet
    count: history.length,
    history,                    // [] when there is no data — the honest answer
  });
});

// What the autonomous Grow loop sent (or paused) while you slept. Founder-only,
// same gate as /ops/health-history. Honest empty when it hasn't run yet.
router.get('/ops/lifecycle-log', requireAuth, requireFounder, async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const c = lifecycle.cfg();
  const [runs, sends] = await Promise.all([
    lifecycle.recentRuns(pool, 20),
    lifecycle.recentSends(pool, limit),
  ]);
  res.json({
    config: {                    // the thresholds a human approved once, for transparency
      enabled: c.enabled, maxFraction: c.maxFraction, minAbs: c.minAbs,
      cooldownDays: c.cooldownDays, activeWindowDays: c.activeWindow,
    },
    runs,                        // recent runs incl. any circuit-breaker pauses
    sendCount: sends.length,
    sends,                       // [] when nothing has been sent — the honest answer
  });
});

// The housing-coverage data-refresh diff report — what the last source refresh
// changed vs the prior snapshot, plus flagged anomalies. Founder-only, same
// gate. Honest empty ({ report: null }) until the first refresh has run.
router.get('/ops/data-diff', requireAuth, requireFounder, async (req, res) => {
  const report = await coverageDiff.latestReport(pool);
  res.json({ report }); // null when no snapshot exists yet — not a fabricated diff
});

// The latest weekly growth digest — real funnel/deltas + the LLM narrative
// around them. Founder-only, same gate. Honest empty ({ digest: null }) until
// the (kill-switch-gated) weekly job has run at least once.
router.get('/ops/growth-digest', requireAuth, requireFounder, async (req, res) => {
  const digest = await growthDigest.latestDigest(pool);
  res.json({ enabled: growthDigest.cfg().enabled, digest });
});

module.exports = router;
