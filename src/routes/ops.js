// ═══════════════════════════════════════════════════════════════════════════
//  Ops — self-reporting status surface for the Watch loop.
//
//  GET /ops/health-history (founder-only): the recent /health poll results the
//  monitor recorded, plus the current debounced status. Honest by construction:
//  before the first poll there is no data, so it returns an EMPTY history and a
//  status of 'unknown' — never a fabricated "all green".
// ═══════════════════════════════════════════════════════════════════════════

const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { requireFounder } = require('../middleware/requireFounder');
const { watcher } = require('../services/healthWatchRunner');

router.get('/ops/health-history', requireAuth, requireFounder, (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const history = watcher.history(limit);
  res.json({
    status: watcher.status(),   // 'unknown' with observations:0 when nothing polled yet
    count: history.length,
    history,                    // [] when there is no data — the honest answer
  });
});

module.exports = router;
