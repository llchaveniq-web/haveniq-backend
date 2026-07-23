/**
 * Close the Loop — per-pair event ledger.
 *
 * POST /pairs/:pairId/events   ingest one event (pair member, or internal key)
 * GET  /pairs/:pairId/timeline the chronological record (research/internal ONLY)
 *
 * `:pairId` is the STABLE PAIR ID — the sorted unordered pair, e.g.
 * "userA:userB" — which is `pair_events.pair_key`. Note the naming trap: the
 * column literally called `pair_id` on that table is the OTHER user's id from
 * the emitter's perspective, which is NOT this. The sorted key is the only
 * identifier both halves of a relationship agree on.
 *
 * PRIVACY: the timeline is a record of two real people's conflict. It is never
 * returned to a normal user — not even to the pair itself — because one side
 * could read the other's private pulses out of it. Research/internal only.
 *
 * CONSENT: no pair is tracked without a `pair_consent` row. v1 is a small,
 * explicitly consented cohort.
 */

const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { requireResearch } = require('../middleware/requireResearch');
const { hasValidInternalKey } = require('../middleware/requireInternalKey');
const pairEvents = require('../services/pairEvents');
const pool = require('../db/pool');

/** Is this user one of the two people in `pairKey`? */
function isMemberOfPair(userId, pairKey) {
  return String(pairKey || '').split(':').includes(String(userId));
}

// ── POST /pairs/:pairId/events ──────────────────────────────────────────────
// Auth: a MEMBER of the pair (their own relationship) or a server-to-server
// caller with the internal key (for events the backend itself emits).
// Idempotent on the client-supplied event id, so a retried emit never
// double-counts — which would quietly inflate an intervention's apparent dose.
router.post('/:pairId/events', async (req, res, next) => {
  if (hasValidInternalKey(req)) return next();          // server-emitted
  return requireAuth(req, res, next);                   // else must be a user
}, async (req, res) => {
  try {
    const pairKey = String(req.params.pairId || '');
    const internal = hasValidInternalKey(req);
    if (!internal && !isMemberOfPair(req.user?.id, pairKey)) {
      return res.status(403).json({ error: 'Not a member of this pair' });
    }

    await pairEvents.ensureTable();
    if (!(await pairEvents.hasConsent(pairKey))) {
      // Not an error the client should retry — the pair simply isn't in the
      // consented cohort. 403 with an explicit reason so a caller can tell this
      // apart from a permissions problem.
      return res.status(403).json({ error: 'Pair has not consented to tracking', consented: false });
    }

    // The emitter is the requesting user; for internal events, the payload must
    // name which member it is on behalf of.
    const emitter = internal ? String(req.body?.userId || '') : String(req.user.id);
    const other = pairKey.split(':').find((id) => id !== emitter);
    if (!emitter || !other) {
      return res.status(400).json({ error: 'Could not resolve the emitting member of the pair' });
    }

    // Reuse the exact normalize/persist path the telemetry stream uses, so
    // there is ONE validator and one insert — a second copy would drift.
    const evt = {
      id: req.body?.id,
      type: 'pair_event',
      payload: { ...(req.body?.payload || req.body || {}), pairId: other },
    };
    const result = await pairEvents.persistBatch([evt], emitter);
    if (result.stored === 0 && result.dropped > 0) {
      return res.status(400).json({ error: 'Malformed pair event', stored: 0 });
    }
    return res.json({ stored: result.stored, deduped: result.stored === 0 });
  } catch (err) {
    console.error('[pairs] ingest failed:', err.message);
    return res.status(500).json({ error: 'ingest failed' });
  }
});

// ── GET /pairs/:pairId/timeline ─────────────────────────────────────────────
// Research/internal only. Chronological, with `episode_id` + `arm` on every
// event so an intervention-vs-control delta is computable downstream.
router.get('/:pairId/timeline', async (req, res, next) => {
  if (hasValidInternalKey(req)) return next();
  return requireAuth(req, res, (err) => (err ? next(err) : requireResearch(req, res, next)));
}, async (req, res) => {
  try {
    const pairKey = String(req.params.pairId || '');
    const events = await pairEvents.timeline(pairKey);

    // Episode roll-up: the shape a cohort query groups on. Reported here so an
    // analyst can see the arms without re-deriving them from every row.
    const episodes = {};
    for (const e of events) {
      if (!e.episodeId) continue;
      const ep = (episodes[e.episodeId] ||= { episodeId: e.episodeId, arm: e.arm, events: 0, firstT: e.t, lastT: e.t });
      ep.events++;
      ep.lastT = e.t;
      if (!ep.arm && e.arm) ep.arm = e.arm;
    }

    res.json({
      pairId: pairKey,
      consented: await pairEvents.hasConsent(pairKey),
      count: events.length,
      events,                                   // [] when nothing recorded — never padded
      episodes: Object.values(episodes),
    });
  } catch (err) {
    console.error('[pairs] timeline failed:', err.message);
    res.status(500).json({ error: 'timeline failed' });
  }
});

// ── POST /pairs/:pairId/consent ─────────────────────────────────────────────
// Records the pair's agreement to be tracked. A member of the pair may consent;
// revoking (POST { revoke: true }) stops future tracking without deleting what
// was already gathered while consent was active.
router.post('/:pairId/consent', requireAuth, async (req, res) => {
  try {
    const pairKey = String(req.params.pairId || '');
    if (!isMemberOfPair(req.user.id, pairKey)) {
      return res.status(403).json({ error: 'Not a member of this pair' });
    }
    await pairEvents.ensureTable();
    if (req.body?.revoke === true) {
      await pool.query('UPDATE pair_consent SET revoked_at = NOW() WHERE pair_id = $1', [pairKey]);
      return res.json({ pairId: pairKey, consented: false, revoked: true });
    }
    const scope = typeof req.body?.scope === 'string' ? req.body.scope.slice(0, 500) : null;
    await pool.query(
      `INSERT INTO pair_consent (pair_id, scope) VALUES ($1, $2)
       ON CONFLICT (pair_id) DO UPDATE SET revoked_at = NULL, scope = COALESCE(EXCLUDED.scope, pair_consent.scope)`,
      [pairKey, scope],
    );
    res.json({ pairId: pairKey, consented: true });
  } catch (err) {
    console.error('[pairs] consent failed:', err.message);
    res.status(500).json({ error: 'consent failed' });
  }
});

module.exports = router;
