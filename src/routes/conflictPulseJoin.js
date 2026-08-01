const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const conflictPulses = require('../services/conflictPulses');

// Must match the frontend's FRESH_MS (utils/earlyWarning.ts): reads older than
// this window are stale and not shown.
const FRESH_DAYS = 21;

// GET /conflict-pulse/:matchId — my roommate's own conflict_pulse reads ABOUT me
// (their user_id, my match_id), within the freshness window. Powers the app's
// "compatibility over time / early warning" counterpart view. Boring query — the
// data lives in a typed table (conflict_pulses), no telemetry_events JSON parsing.
router.get('/:matchId', requireAuth, async (req, res) => {
  try {
    const myId = String(req.user.id);
    const otherId = String(req.params.matchId);
    if (!otherId || otherId === myId) {
      return res.status(400).json({ ok: false, error: 'Invalid matchId' });
    }

    const reads = await conflictPulses.freshReads(otherId, myId, FRESH_DAYS);
    res.json({ ok: true, reads });
  } catch (err) {
    console.error('[conflict-pulse-join] GET /:matchId failed', err);
    res.status(500).json({ ok: false, reads: [] });
  }
});

module.exports = router;
