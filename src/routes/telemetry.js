const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

// ─── Allowed event types ─────────────────────────────────────────────────
// Mirror of the client-side TelemetryEventType union. The DB has a CHECK
// constraint that enforces this same list — we filter here too so that
// a single bad event in a batch doesn't fail the entire transaction.
const ALLOWED_TYPES = new Set([
  'behavioral_event', 'biometric_sample', 'writing_fingerprint',
  'quiz_answer', 'pulse_snapshot', 'mood_entry',
  'johari_self_description', 'johari_peer_vouch',
  'goals_update', 'goals_value_ranking', 'goals_vision',
  'schedule_block', 'social_connection', 'social_group',
  'voice_recording_meta', 'integration_connected', 'time_capsule',
  'financial_profile', 'profile_update', 'validation_score',
]);

// ─── POST /telemetry/batch ───────────────────────────────────────────────
// Called by the client every ~5 seconds with up to 50 events at a time.
// Inserts everything in a single transaction so partial batches never
// leave the DB in an inconsistent state. Uses ON CONFLICT DO NOTHING so
// client-side retries are idempotent (no duplicates even if the same
// event id arrives twice).
router.post('/batch', requireAuth, async (req, res) => {
  const { deviceId, events } = req.body;
  const userId = req.user.id;

  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'events required' });
  }
  if (events.length > 100) {
    return res.status(413).json({ error: 'batch too large (max 100 events)' });
  }
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    return res.status(400).json({ error: 'deviceId required' });
  }

  const valid = events.filter(e =>
    e && typeof e.id === 'string'
    && ALLOWED_TYPES.has(e.type)
    && typeof e.timestamp === 'number'
    && typeof e.category === 'string'
    && e.payload && typeof e.payload === 'object'
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const evt of valid) {
      await client.query(
        `INSERT INTO telemetry_events
           (id, user_id, device_id, event_type, category, client_ts, payload)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), $7)
         ON CONFLICT (id) DO NOTHING`,
        [evt.id, userId, deviceId, evt.type, evt.category, evt.timestamp, evt.payload]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Telemetry batch insert failed:', err);
    return res.status(500).json({ error: 'insert failed' });
  } finally {
    client.release();
  }

  res.json({ accepted: valid.length, dropped: events.length - valid.length });
});

// ─── GET /telemetry/my-data ──────────────────────────────────────────────
// GDPR Article 15 — Right of Access. The user can pull everything we've
// ever recorded about them. Returns JSON; client can download it as a file.
router.get('/my-data', requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT id, event_type, category, client_ts, server_ts, payload
       FROM telemetry_events
       WHERE user_id = $1
       ORDER BY client_ts DESC
       LIMIT 50000`,
      [userId]
    );
    res.json({ userId, eventCount: rows.length, events: rows });
  } catch (err) {
    console.error('Telemetry export failed:', err);
    res.status(500).json({ error: 'export failed' });
  }
});

// ─── DELETE /telemetry/my-data ───────────────────────────────────────────
// GDPR Article 17 — Right to Erasure. Wipes every telemetry event AND the
// per-user profile snapshot for this user. The user account itself stays
// (handled by a separate /users/me DELETE endpoint if you build one).
router.delete('/my-data', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount: eventsDeleted } = await client.query(
      'DELETE FROM telemetry_events WHERE user_id = $1',
      [userId]
    );
    await client.query(
      'DELETE FROM user_profile_snapshot WHERE user_id = $1',
      [userId]
    );
    await client.query('COMMIT');
    res.json({ deleted: true, eventsDeleted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Telemetry deletion failed:', err);
    res.status(500).json({ error: 'deletion failed' });
  } finally {
    client.release();
  }
});

// ─── POST /telemetry/consent ─────────────────────────────────────────────
// Audit log of every consent change. Required for GDPR Article 7 (proof
// that consent was given). Append-only — never updates, only inserts.
router.post('/consent', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { category, allowed } = req.body;
  if (typeof category !== 'string' || typeof allowed !== 'boolean') {
    return res.status(400).json({ error: 'category (string) and allowed (boolean) required' });
  }
  try {
    await pool.query(
      'INSERT INTO consent_log (user_id, category, allowed) VALUES ($1, $2, $3)',
      [userId, category, allowed]
    );
    res.json({ recorded: true });
  } catch (err) {
    console.error('Consent log failed:', err);
    res.status(500).json({ error: 'log failed' });
  }
});

module.exports = router;