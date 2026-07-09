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

  // 2d: persist the latest behavioral validation_score onto the user so the
  // scorer's step-4 multiplier can read a live value (telemetry_events keeps
  // the full history; users.validation_score is the current snapshot). Score is
  // [0,1]; best-effort so a persist hiccup never fails the telemetry batch.
  try {
    const vEvents = valid.filter(e =>
      e.type === 'validation_score' && e.payload &&
      typeof e.payload.score === 'number' && e.payload.score >= 0 && e.payload.score <= 1);
    if (vEvents.length) {
      const latest = vEvents.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
      await pool.query(
        `UPDATE users SET validation_score = $1, validation_sample_size = $2 WHERE id = $3`,
        [latest.payload.score, Number.isInteger(latest.payload.sampleSize) ? latest.payload.sampleSize : null, userId],
      );
    }
  } catch (e) {
    console.error('[telemetry] validation_score persist failed:', e.message);
  }

  // Deep-matching #6: persist pulse_drift (trajectory/velocity) into dedicated
  // tables. pulse_drift is NOT in ALLOWED_TYPES (so it never enters the generic
  // telemetry_events CHECK) — we pull it straight from the raw batch. We TRUST
  // the app's velocity (it owns the baseline anchor + answer→value scaling);
  // never recompute it here. Latest per (user, question) drives scoring; history
  // lets the trainer reconstruct velocity at a pairing's serve time. Best-effort
  // so a drift hiccup never fails the telemetry batch.
  try {
    const driftEvents = (Array.isArray(events) ? events : []).filter(
      e => e && e.type === 'pulse_drift' && e.payload && Array.isArray(e.payload.byQuestion),
    );
    if (driftEvents.length) {
      // One snapshot per batch is normal; if several, the newest wins per question.
      const latest = driftEvents.reduce((a, b) =>
        ((b.payload.computedAt || b.timestamp || 0) > (a.payload.computedAt || a.timestamp || 0) ? b : a));
      const computedAt = Number.isFinite(Date.parse(latest.payload.computedAt))
        ? new Date(latest.payload.computedAt).toISOString() : null;
      const snapshotId = typeof latest.payload.snapshotId === 'string' ? latest.payload.snapshotId : null;
      const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
      const int = (x) => (Number.isInteger(x) ? x : null);

      for (const bq of latest.payload.byQuestion) {
        const qid = int(bq && bq.questionId);
        if (qid === null) continue;
        const v = num(bq.velocity), cur = num(bq.current), base = num(bq.baseline),
              del = num(bq.delta), ss = int(bq.sampleSize);
        const trend = ['stable', 'shifting', 'changed'].includes(bq.trend) ? bq.trend : null;
        await pool.query(
          `INSERT INTO pulse_drift
             (user_id, question_id, velocity, baseline, current, delta, trend, sample_size, snapshot_id, computed_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
           ON CONFLICT (user_id, question_id) DO UPDATE
             SET velocity=EXCLUDED.velocity, baseline=EXCLUDED.baseline, current=EXCLUDED.current,
                 delta=EXCLUDED.delta, trend=EXCLUDED.trend, sample_size=EXCLUDED.sample_size,
                 snapshot_id=EXCLUDED.snapshot_id, computed_at=EXCLUDED.computed_at, updated_at=NOW()`,
          [userId, qid, v, base, cur, del, trend, ss, snapshotId, computedAt],
        );
        await pool.query(
          `INSERT INTO pulse_drift_history
             (user_id, question_id, velocity, current, trend, sample_size, snapshot_id, computed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [userId, qid, v, cur, trend, ss, snapshotId, computedAt],
        );
      }
    }
  } catch (e) {
    console.error('[telemetry] pulse_drift persist failed:', e.message);
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
    // Deep-matching #5: on textInsight WITHDRAWAL, purge the user's derived
    // construct vector immediately (we stop using it the moment consent drops).
    const textInsight = require('../services/textInsight');
    if (category === textInsight.TEXT_INSIGHT_CONSENT && allowed === false) {
      textInsight.purge(userId).catch(() => {});
    }
    res.json({ recorded: true });
  } catch (err) {
    console.error('Consent log failed:', err);
    res.status(500).json({ error: 'log failed' });
  }
});

// ─── POST /telemetry/report ──────────────────────────────────────────────
// In-app "Report a problem" button — catches the bugs Sentry can't (silent
// UI failures, confusing UX, wrong-color complaints). Posts to Discord
// via DISCORD_WEBHOOK_URL so the founder sees it inline with the other
// bot alerts. Rate-limited to one report per user per 60 sec to prevent
// accidental spam from a stuck button.
const recentReports = new Map(); // userId -> last-report timestamp
router.post('/report', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { message, screen, userAgent, appVersion } = req.body || {};

  if (typeof message !== 'string' || message.trim().length < 3) {
    return res.status(400).json({ error: 'message required (min 3 chars)' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'message too long (max 2000 chars)' });
  }

  // Per-user 60-sec rate limit
  const now = Date.now();
  const last = recentReports.get(userId) || 0;
  if (now - last < 60_000) {
    return res.status(429).json({ error: 'please wait a minute before reporting again' });
  }
  recentReports.set(userId, now);

  // Best-effort: log to the DB so we have a permanent audit trail
  try {
    // The original DDL declared user_id BIGINT against the UUID users.id PK, so
    // this table either never created or every insert failed silently — reports
    // were never persisted (only Discord got them). Self-heal safely: the table
    // is provably empty (inserts were failing), so drop-if-broken, then recreate
    // with the correct UUID type + the support-triage columns. Idempotent — once
    // fixed, the DO block finds no bigint column and does nothing.
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'user_problem_reports'
            AND column_name = 'user_id' AND data_type = 'bigint'
        ) THEN
          DROP TABLE user_problem_reports;
        END IF;
      END $$;
    `);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS user_problem_reports (
         id          BIGSERIAL PRIMARY KEY,
         user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
         message     TEXT NOT NULL,
         screen      TEXT,
         user_agent  TEXT,
         app_version TEXT,
         status      TEXT NOT NULL DEFAULT 'open',
         staff_reply TEXT,
         replied_at  TIMESTAMPTZ,
         handled_by  UUID,
         created_at  TIMESTAMPTZ DEFAULT NOW()
       )`
    );
    // Belt-and-suspenders: add the support-triage columns to any pre-existing
    // (correctly-typed) table that predates them.
    await pool.query(`ALTER TABLE user_problem_reports ADD COLUMN IF NOT EXISTS status      TEXT NOT NULL DEFAULT 'open'`);
    await pool.query(`ALTER TABLE user_problem_reports ADD COLUMN IF NOT EXISTS staff_reply TEXT`);
    await pool.query(`ALTER TABLE user_problem_reports ADD COLUMN IF NOT EXISTS replied_at  TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE user_problem_reports ADD COLUMN IF NOT EXISTS handled_by  UUID`);
    await pool.query(
      `INSERT INTO user_problem_reports (user_id, message, screen, user_agent, app_version)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, message.trim(), screen ?? null, userAgent ?? null, appVersion ?? null]
    );
  } catch (err) {
    console.error('[telemetry/report] DB insert failed:', err.message);
    // Don't block the response — still attempt Discord post below
  }

  // Forward to Discord (fire-and-forget, but log failures)
  const hook = process.env.DISCORD_WEBHOOK_URL;
  if (hook) {
    try {
      // Pull a bit of user context so the founder can recognize who it is
      const { rows } = await pool.query(
        'SELECT email, first_name, school FROM users WHERE id = $1',
        [userId]
      );
      const u = rows[0] || {};
      const r = await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            title: '🙋 User-reported problem',
            description: '```' + message.trim().slice(0, 1900) + '```',
            color: 0xF59E0B,
            fields: [
              { name: 'User', value: `${u.first_name ?? '?'} <${u.email ?? '?'}>`, inline: true },
              { name: 'School', value: u.school ?? '—', inline: true },
              { name: 'Screen', value: screen || '—', inline: true },
              { name: 'App version', value: appVersion || '—', inline: true },
              { name: 'Device', value: (userAgent || '—').slice(0, 200), inline: false },
            ],
            footer: { text: 'In-app report • user tapped Report a Problem' },
            timestamp: new Date().toISOString(),
          }],
        }),
      });
      if (!r.ok) console.error('[telemetry/report] Discord webhook returned', r.status);
    } catch (err) {
      console.error('[telemetry/report] Discord post failed:', err.message);
    }
  }

  res.json({ received: true });
});

module.exports = router;