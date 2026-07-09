// ═══════════════════════════════════════════════════════════════════════════
//  Safety-report backlog digest — the trust-&-safety operational nudge.
//
//  Individual reports already alert the founder in real time (both the
//  profile-report and the message-report paths fire sendSafetyAlertEmail). This
//  is the BACKLOG guard: a once-daily count of reports still sitting in `open`,
//  pinged to the ops Discord so a report can't quietly rot in the queue because
//  nobody remembered to open /admin/safety. Triage is currently a bus-factor of
//  one, so a standing "N still open" nudge is the cheap safety net.
//
//  Fires ONLY when there's an open backlog (n > 0) AND a Discord hook is set —
//  silent on a clean queue. Read-only, sends nothing to users, takes no action.
//  Best-effort: a webhook or DB hiccup must never throw into the scheduler.
//
//  Deps are injectable (db / fetchFn / now) so the count + ping-gating logic is
//  unit-testable without a live DB, network, or timers.
// ═══════════════════════════════════════════════════════════════════════════

const realPool = require('../db/pool');

const DAY_MS = 24 * 60 * 60 * 1000;

async function runSafetyDigest({ db = realPool, fetchFn = fetch, now = Date.now } = {}) {
  // Open reports, how many are acute (HIGH/urgent), and the age of the oldest —
  // so the ping conveys urgency, not just a bare count.
  const { rows } = await db.query(
    `SELECT
        COUNT(*)::int                                              AS open_total,
        COUNT(*) FILTER (WHERE severity IN ('high','urgent'))::int AS high_total,
        MIN(created_at)                                            AS oldest
       FROM user_reports
      WHERE status = 'open'`,
  );
  const openTotal = rows[0]?.open_total ?? 0;
  const highTotal = rows[0]?.high_total ?? 0;
  const oldest    = rows[0]?.oldest ?? null;

  if (!openTotal) return { open: 0, pinged: false };   // clean queue — stay quiet

  const oldestDays = oldest
    ? Math.floor((now() - new Date(oldest).getTime()) / DAY_MS)
    : 0;

  const hook = process.env.DISCORD_WEBHOOK_URL || '';
  if (!hook) return { open: openTotal, high: highTotal, oldestDays, pinged: false };

  // Red when any acute report is waiting; amber otherwise.
  const color = highTotal > 0 ? 0xC0392B : 0xE67E22;
  await fetchFn(hook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: '🚩 open safety reports awaiting review',
        description: `**${openTotal}** report${openTotal === 1 ? '' : 's'} still open`
          + (highTotal > 0 ? ` — **${highTotal} HIGH**` : '')
          + `. Oldest: ${oldestDays}d ago. Triage at /admin/safety.`,
        color,
        footer: { text: 'Safety digest • daily • pings only when the queue is non-empty' },
      }],
    }),
  }).catch(() => {});

  return { open: openTotal, high: highTotal, oldestDays, pinged: true };
}

module.exports = { runSafetyDigest };
