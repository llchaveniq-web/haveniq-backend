// ═══════════════════════════════════════════════════════════════════════════
//  The Grow loop's AUTONOMOUS lifecycle sender.
//
//  Runs unattended on the existing scheduler. A human approves the templates +
//  thresholds ONCE in code review; after that the job segments users by real
//  state and sends the matching frozen template with NO per-batch approval.
//  Guardrails replace the human gate:
//    • Kill switch  — WATCH_LIFECYCLE_ENABLED must be 'true'; default OFF.
//    • Frequency cap — >=1 lifecycle email in the cooldown window excludes a
//      user (enforced in SQL) so a re-run cannot double-send.
//    • Circuit breaker — if a run would send to more than
//      max(minAbs, activeUsers*maxFraction) recipients, it PAUSES (never sends)
//      and pages Discord: the fail-safe against a segmentation bug blasting
//      everyone.
//    • Consent + honesty — suppressed/opted-out users are filtered in SQL;
//      templates carry no per-user numbers.
//    • Audit — every send is logged (user, template, time); every run is logged
//      (incl. paused ones) for GET /ops/lifecycle-log.
//
//  Only the circuit-breaker trip pages a human, and even then it fails safe by
//  pausing rather than sending. Everything is best-effort: a send failure logs
//  and continues; the job never throws into the scheduler.
// ═══════════════════════════════════════════════════════════════════════════

const poolDefault = require('../db/pool');
const { SEGMENTS, ACTIVE_USERS_SQL, dedupByPriority, circuitBreaker } = require('./lifecycleSegments');
const { TEMPLATES, render, LIST_UNSUBSCRIBE, UNSUB_MAILTO, FROM } = require('./lifecycleTemplates');
const { isDemoEmail } = require('../lib/demoFilter');
const { sign: signUnsub } = require('../lib/unsubscribeToken');
const sentry = require('../utils/sentry');

// Base URL for the one-click unsubscribe link — this backend serves /unsubscribe.
const UNSUB_BASE = (process.env.API_PUBLIC_URL || process.env.PUBLIC_API_URL
  || 'https://haveniq-backend-production.up.railway.app').replace(/\/$/, '');
// Build a recipient's signed one-click link + the RFC 8058 headers for it.
function unsubFor(userId) {
  const url = `${UNSUB_BASE}/unsubscribe?token=${encodeURIComponent(signUnsub(userId, 'lifecycle'))}`;
  return {
    url,
    headers: {
      'List-Unsubscribe': `<${url}>, <${UNSUB_MAILTO}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const cfg = () => ({
  enabled:      process.env.WATCH_LIFECYCLE_ENABLED === 'true', // default OFF
  maxFraction:  num(process.env.WATCH_LIFECYCLE_MAX_FRACTION, 0.10),
  minAbs:       num(process.env.WATCH_LIFECYCLE_MIN_ABS, 10),   // small-batch allowance; 0 = pure fraction
  cooldownDays: num(process.env.WATCH_LIFECYCLE_COOLDOWN_DAYS, 7),
  activeWindow: num(process.env.WATCH_LIFECYCLE_ACTIVE_WINDOW_DAYS, 30),
  hardCap:      num(process.env.WATCH_LIFECYCLE_HARD_CAP, 2000), // absolute per-run backstop
});

async function ensureTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lifecycle_sends (
      id          BIGSERIAL PRIMARY KEY,
      user_id     UUID,
      email       TEXT,
      segment     TEXT,
      template_id TEXT,
      status      TEXT NOT NULL,          -- 'sent' | 'failed'
      error       TEXT,
      sent_at     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_lifecycle_sends_user ON lifecycle_sends(user_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lifecycle_sends_time ON lifecycle_sends(sent_at DESC);

    CREATE TABLE IF NOT EXISTS lifecycle_runs (
      id           BIGSERIAL PRIMARY KEY,
      enabled      BOOLEAN,
      active_count INT,
      threshold    INT,
      planned      INT,
      sent         INT,
      failed       INT,
      paused       BOOLEAN,
      by_segment   JSONB,
      note         TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_lifecycle_runs_time ON lifecycle_runs(created_at DESC);
  `).catch((e) => console.error('[lifecycle] ensure tables:', e.message));
}

// ── The Discord page — ONLY on a circuit-breaker trip. Best-effort. ─────────
async function pageCircuitBreaker(info, fetchImpl) {
  const hook = process.env.DISCORD_WEBHOOK_URL || '';
  try { sentry.captureError(new Error('signal:lifecycle_circuit_breaker'), info); } catch { /* best-effort */ }
  if (!hook) return;
  const f = fetchImpl || fetch;
  await f(hook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: '🛑 signal:lifecycle_circuit_breaker',
        description: `Lifecycle run PAUSED — it would have sent to **${info.plannedCount}** users but the cap is **${info.threshold}** `
          + `(${Math.round((info.maxFraction || 0) * 100)}% of ${info.activeCount} active). Nothing was sent. A human should check the segmentation before enabling this batch.`,
        color: 0xC0392B,
        timestamp: info.at || new Date().toISOString(),
        footer: { text: 'Grow loop • fail-safe pause • no emails sent' },
      }],
    }),
  }).catch(() => {});
}

// Real email send via the existing Resend path. Per-recipient List-Unsubscribe
// headers (RFC 8058 one-click) are passed in by the caller; the static header is
// only a fallback if a caller omits them.
async function defaultSendEmail({ to, subject, text, html, headers }) {
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: FROM, to, subject, text, html,
    headers: { 'List-Unsubscribe': LIST_UNSUBSCRIBE, ...(headers || {}) },
  });
}

// Gather each segment's recipients (SQL already applies eligibility, consent,
// and the frequency cap), in priority order.
async function collectRecipients(pool, cooldownDays) {
  const bySegment = [];
  for (const seg of SEGMENTS) {
    let rows = [];
    try {
      const r = await pool.query(seg.sql, [cooldownDays]);
      rows = r.rows;
    } catch (e) {
      console.warn(`[lifecycle] segment ${seg.id} soft-fail:`, e.message);
    }
    bySegment.push({ segmentId: seg.id, templateId: seg.templateId, recipients: rows });
  }
  return bySegment;
}

// The run. Injectable (pool / sendEmail / alert / enabled / now) for tests.
async function runLifecycle(opts = {}) {
  const pool = opts.pool || poolDefault;
  const c = { ...cfg(), ...(opts.config || {}) };
  const enabled = opts.enabled != null ? opts.enabled : c.enabled;
  const sendEmail = opts.sendEmail || defaultSendEmail;
  const alert = opts.alert || pageCircuitBreaker;
  const nowIso = opts.now || new Date().toISOString();

  // Kill switch — the hard stop. No table touches, no sends.
  if (!enabled) return { ok: true, enabled: false, skipped: 'disabled', sent: 0, planned: 0 };

  await ensureTables(pool);

  // Denominator + planned recipients.
  let activeCount = 0;
  try {
    const r = await pool.query(ACTIVE_USERS_SQL, [c.activeWindow]);
    activeCount = r.rows[0] ? r.rows[0].n : 0;
  } catch (e) { console.warn('[lifecycle] active-count soft-fail:', e.message); }

  const bySegment = await collectRecipients(pool, c.cooldownDays);
  const planned = dedupByPriority(bySegment);
  const bySegmentCounts = {};
  for (const p of planned) bySegmentCounts[p.segmentId] = (bySegmentCounts[p.segmentId] || 0) + 1;

  const breaker = circuitBreaker(planned.length, activeCount, c.maxFraction, c.minAbs);

  // ── Circuit-breaker trip → PAUSE (fail safe) + page a human. No sends. ─────
  if (breaker.trip) {
    await alert({ ...breaker, at: nowIso });
    await logRun(pool, {
      enabled: true, activeCount, threshold: breaker.threshold, planned: planned.length,
      sent: 0, failed: 0, paused: true, bySegment: bySegmentCounts,
      note: `paused: ${planned.length} > cap ${breaker.threshold}`,
    }).catch(() => {});
    return { ok: true, enabled: true, paused: true, planned: planned.length, threshold: breaker.threshold, activeCount, bySegment: bySegmentCounts };
  }

  // ── Within budget → send autonomously, logging every send. ────────────────
  let sent = 0, failed = 0;
  for (const p of planned) {
    if (sent >= c.hardCap) break;                    // absolute backstop
    if (!p.email || isDemoEmail(p.email)) continue;  // belt-and-suspenders vs demo/null
    const tpl = TEMPLATES[p.segmentId];
    if (!tpl) continue;
    const unsub = unsubFor(p.userId);
    const msg = render(tpl, { firstName: p.firstName, unsubUrl: unsub.url });
    try {
      await sendEmail({ to: p.email, subject: msg.subject, text: msg.text, html: msg.html, headers: unsub.headers });
      sent += 1;
      await recordSend(pool, p, 'sent', null).catch(() => {});
    } catch (err) {
      failed += 1;
      await recordSend(pool, p, 'failed', String(err && err.message || err).slice(0, 300)).catch(() => {});
    }
  }

  await logRun(pool, {
    enabled: true, activeCount, threshold: breaker.threshold, planned: planned.length,
    sent, failed, paused: false, bySegment: bySegmentCounts, note: null,
  }).catch(() => {});

  return { ok: true, enabled: true, paused: false, activeCount, threshold: breaker.threshold, planned: planned.length, sent, failed, bySegment: bySegmentCounts };
}

async function recordSend(pool, p, status, error) {
  return pool.query(
    `INSERT INTO lifecycle_sends (user_id, email, segment, template_id, status, error)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [p.userId, p.email, p.segmentId, p.templateId, status, error],
  );
}

async function logRun(pool, r) {
  return pool.query(
    `INSERT INTO lifecycle_runs (enabled, active_count, threshold, planned, sent, failed, paused, by_segment, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [r.enabled, r.activeCount, r.threshold, r.planned, r.sent, r.failed, r.paused, JSON.stringify(r.bySegment || {}), r.note],
  );
}

// ── Read side for /ops/lifecycle-log (soft-fails to empty) ──────────────────
async function recentSends(pool, limit = 100) {
  try {
    const { rows } = await pool.query(
      `SELECT user_id, email, segment, template_id, status, error, sent_at
         FROM lifecycle_sends ORDER BY sent_at DESC LIMIT $1`, [limit]);
    return rows;
  } catch (e) { console.error('[lifecycle] recentSends:', e.message); return []; }
}
async function recentRuns(pool, limit = 20) {
  try {
    const { rows } = await pool.query(
      `SELECT enabled, active_count, threshold, planned, sent, failed, paused, by_segment, note, created_at
         FROM lifecycle_runs ORDER BY created_at DESC LIMIT $1`, [limit]);
    return rows;
  } catch (e) { console.error('[lifecycle] recentRuns:', e.message); return []; }
}

module.exports = {
  runLifecycle, ensureTables, pageCircuitBreaker, defaultSendEmail,
  recentSends, recentRuns, cfg,
};
