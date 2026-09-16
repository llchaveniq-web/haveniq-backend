const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const conflictPulses = require('../services/conflictPulses');
// Same "same-campus or connected pair" gate matches.js's /:userId/score-history,
// /openers, /explain all use — this route had NO relationship check at all
// (only requireAuth), which is exactly the bug class those three were fixed
// for: any authed user could pass an arbitrary :matchId and, without this,
// learn whether that specific person has ever logged a private conflict-pulse
// read about them, entirely outside an active match. Reusing the existing,
// already-proven gate rather than writing a second copy of the same check.
const { mayViewMatchDetail } = require('./matches');

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
    if (!(await mayViewMatchDetail(myId, req.user.school, otherId))) {
      return res.status(403).json({ ok: false, error: 'not a match' });
    }

    const reads = await conflictPulses.freshReads(otherId, myId, FRESH_DAYS);
    res.json({ ok: true, reads });
  } catch (err) {
    console.error('[conflict-pulse-join] GET /:matchId failed', err);
    res.status(500).json({ ok: false, reads: [] });
  }
});

module.exports = router;
