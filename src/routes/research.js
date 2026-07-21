/**
 * Research export — the longitudinal pair dataset.
 *
 * This is the ONLY surface that may join both sides of a pairing. That is the
 * point of it: the research question ("for topics that got an intervention, did
 * the strain fall afterward, and did the pair stay?") cannot be answered from
 * one side alone. It is also exactly why it sits behind requireResearch and not
 * a normal user token — one roommate's `signal` events are their own pulse, and
 * no product endpoint returns those to the other person.
 *
 * Everything here is read-only, and reports what the stream actually sent. A
 * pairing with no outcome comes back with no outcome.
 */

const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { requireResearch } = require('../middleware/requireResearch');
const pairEvents = require('../services/pairEvents');

const MAX_LIMIT = 50000;

// Small honest summary so an analyst can see the shape of what they pulled
// without a second pass — including any subtype the backend doesn't know about,
// which is how app-side vocabulary drift becomes visible rather than silent.
function summarize(rows) {
  const kinds = {}, subtypes = {}, pairs = new Set();
  for (const r of rows) {
    kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    subtypes[r.subtype] = (subtypes[r.subtype] || 0) + 1;
    pairs.add(r.pairKey);
  }
  const unknownSubtypes = Object.keys(subtypes).filter(s => !pairEvents.KNOWN_SUBTYPES.has(s));
  return { kinds, subtypes, pairCount: pairs.size, unknownSubtypes };
}

// ── GET /research/pairs/:pairKey/timeline ────────────────────────────────────
// One pairing's full timeline, both sides, ordered by the client clock — the
// set the app's local exportPairTimeline produces for that pair.
router.get('/pairs/:pairKey/timeline', requireAuth, requireResearch, async (req, res) => {
  try {
    const pairKey = String(req.params.pairKey || '');
    if (!pairKey) return res.status(400).json({ error: 'pairKey required' });
    const events = await pairEvents.timeline(pairKey);
    res.json({
      pairKey,
      count: events.length,
      events,                        // [] when this pair has emitted nothing yet
      summary: summarize(events),
    });
  } catch (err) {
    console.error('[research] timeline failed:', err.message);
    res.status(500).json({ error: 'export failed' });
  }
});

// ── GET /research/pair-events?since=<ms>&limit=<n> ───────────────────────────
// Bulk cohort export. `since` is the client clock (payload.t), so it lines up
// with the timeline ordering rather than server insert time.
router.get('/pair-events', requireAuth, requireResearch, async (req, res) => {
  try {
    const since = Number(req.query.since);
    const sinceMs = Number.isFinite(since) ? Math.trunc(since) : 0;
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(rawLimit)))
      : MAX_LIMIT;

    const events = await pairEvents.since(sinceMs, limit);
    res.json({
      since: sinceMs,
      count: events.length,
      // Tells the caller to page rather than assume they got everything — a
      // truncated export that looks complete is how a cohort analysis quietly
      // draws a conclusion from half the data.
      truncated: events.length === limit,
      nextSince: events.length ? events[events.length - 1].t : sinceMs,
      events,
      summary: summarize(events),
    });
  } catch (err) {
    console.error('[research] bulk export failed:', err.message);
    res.status(500).json({ error: 'export failed' });
  }
});

module.exports = router;
