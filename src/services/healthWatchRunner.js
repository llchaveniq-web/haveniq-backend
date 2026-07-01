// ═══════════════════════════════════════════════════════════════════════════
//  Side-effecting half of the Watch-loop monitor: the process-wide singleton
//  watcher, the self-poll against /health, and the alert sinks. The route reads
//  this singleton's history; the scheduler calls pollOnce() on an interval.
//
//  Kept separate from healthWatch.js so the debounce/transition core stays pure
//  and unit-testable without a network, timers, or the Discord webhook.
// ═══════════════════════════════════════════════════════════════════════════

const { createWatcher, classify } = require('./healthWatch');
const sentry = require('../utils/sentry');

const DISCORD_HOOK   = process.env.DISCORD_WEBHOOK_URL || '';
const EXPECTED_SHA   = process.env.WATCH_EXPECTED_SHA || null; // opt-in SHA-mismatch tripwire
const POLL_TIMEOUT_MS = 4000;

// Page the human — the `signal:backend_outage` alert. Best-effort: a webhook
// failure must never throw into the scheduler. Fires ONLY on the transition.
async function pageOutage(record, meta) {
  const reasons = (record.reasons || []).join(', ') || 'unknown';
  const line = `🔴 **signal:backend_outage** — backend went UNHEALTHY after ${meta.consecutiveFail} consecutive failed checks.`;
  try { sentry.captureError(new Error('signal:backend_outage'), { reasons, sha: record.sha, httpStatus: record.httpStatus }); } catch { /* best-effort */ }
  if (!DISCORD_HOOK) return;
  await fetch(DISCORD_HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: '🔴 signal:backend_outage',
        description: line,
        color: 0xC0392B,
        fields: [
          { name: 'Reasons', value: `\`${reasons}\``.slice(0, 1000), inline: false },
          { name: 'Live SHA', value: `\`${record.sha || '?'}\``, inline: true },
          { name: 'HTTP', value: `\`${record.httpStatus || 'none'}\``, inline: true },
          { name: 'DB', value: `\`${record.db || '?'}\``, inline: true },
        ],
        timestamp: record.timestamp,
        footer: { text: 'Watch loop • /health self-poll • paged on transition only' },
      }],
    }),
  }).catch(() => {});
}

// Clear the alert on recovery.
async function clearOutage(record, meta) {
  try { sentry.captureError(new Error('signal:backend_outage cleared'), { sha: record.sha }); } catch { /* best-effort */ }
  if (!DISCORD_HOOK) return;
  await fetch(DISCORD_HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: '🟢 signal:backend_outage — RECOVERED',
        description: `Backend healthy again after ${meta.consecutiveOk} consecutive good checks.`,
        color: 0x2ECC71,
        fields: [{ name: 'Live SHA', value: `\`${record.sha || '?'}\``, inline: true }],
        timestamp: record.timestamp,
        footer: { text: 'Watch loop • /health self-poll' },
      }],
    }),
  }).catch(() => {});
}

// Process-wide singleton — one watcher shared by the poller and the route.
const watcher = createWatcher({ onFire: pageOutage, onClear: clearOutage });

// One poll: hit /health, classify, feed the debounce. Never throws.
async function pollOnce(url) {
  const target = url || process.env.WATCH_HEALTH_URL
    || `http://127.0.0.1:${process.env.PORT || 3000}/health`;
  const started = Date.now();
  let raw;
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON body → body stays null */ }
    raw = { httpStatus: res.status, body, latencyMs: Date.now() - started };
  } catch (err) {
    raw = { httpStatus: null, body: null, latencyMs: Date.now() - started, error: err.name || 'fetch_failed' };
  }
  return watcher.observe(classify(raw, EXPECTED_SHA));
}

module.exports = { watcher, pollOnce, pageOutage, clearOutage, EXPECTED_SHA };
