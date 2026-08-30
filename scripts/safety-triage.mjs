/**
 * Safety report auto-triage — hourly cron.
 *
 * Polls /bot-admin/pending-reports for `status='open'` user reports.
 * For each one, asks Claude to classify into ONE of:
 *   • dismiss           — clearly bad-faith / accidental / no actual harm
 *   • warn              — minor, log a warning but no account action
 *   • restrict          — reduce visibility, hide from matches (human still confirms)
 *   • ban               — clear violation, permanent action (human still confirms)
 *   • human-review      — anything ambiguous
 *
 * Auto-actions:
 *   • dismiss (confidence high) → POST /bot-admin/report/:id/dismiss
 *   • everything else            → POST /bot-admin/report/:id/escalate +
 *                                  @here Discord ping with the bot's
 *                                  suggestion attached
 *
 * Conservative defaults: when in doubt, ESCALATE. The only auto-action
 * the bot takes alone is dismissing reports that are clearly noise
 * (accidental tap, the reporter's reason is a joke or nonsense, etc.).
 * We never auto-ban or auto-restrict — those are human-only by design.
 *
 * Cost: ~$0.02 per report × ~10 reports/day at scale = ~$6/mo.
 */

import Anthropic from '@anthropic-ai/sdk';

const env = (k) => (process.env[k] ?? '').replace(/[^\x20-\x7E]/g, '');

const BACKEND_URL   = 'https://haveniq-backend-production.up.railway.app';
const ADMIN_TOKEN   = env('HAVENIQ_ADMIN_TOKEN');
const ANTHROPIC_KEY = env('ANTHROPIC_API_KEY');
const DISCORD_HOOK  = env('DISCORD_WEBHOOK_URL');
const MAX_PER_RUN   = 10;

// ── Backend ────────────────────────────────────────────────────────────

async function bot(method, path, body) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Claude classifier ─────────────────────────────────────────────────

const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

async function classify(report) {
  const prompt = `You are triaging a safety report on HavenIQ, a .edu-verified roommate-matching app. Your decisions affect real students. Be conservative.

REPORT:
  category:  ${report.category ?? '?'}
  severity:  ${report.severity ?? '?'}
  reason:    ${report.reason ?? '(none)'}
  details:   ${(report.details ?? '').slice(0, 1000)}

REPORTER:
  name:       ${report.reporter_first_name ?? '?'}
  school:     ${report.reporter_school ?? '?'}
  verified:   ${report.reporter_is_verified}

REPORTED USER:
  name:       ${report.reported_first_name ?? '?'}
  school:     ${report.reported_school ?? '?'}
  verified:   ${report.reported_is_verified}
  already_banned: ${report.reported_is_banned}
  trust_score: ${report.reported_trust_score}
  account_age_days: ${Math.round((Date.now() - new Date(report.reported_created_at).getTime()) / 86400000)}

Output ONLY a JSON object:
{
  "decision":   "dismiss" | "warn" | "restrict" | "ban" | "human-review",
  "confidence": "low" | "medium" | "high",
  "reason":     "<one-sentence rationale>",
  "suggested_human_action": "<short imperative for the founder>"
}

DECISION RULES — strict:
- dismiss : ONLY if the report is obviously bad-faith / nonsense / accidental tap. Examples: report reason is "test", "lol", empty, or a joke. Reporter is NOT verified AND has no details.
- warn / restrict / ban : NEVER pick these autonomously. We always escalate destructive actions to a human.
- human-review : default for ANYTHING serious, ambiguous, or where stakes matter. Most reports land here.

When in doubt: human-review. We'd rather waste a founder minute than miss a real incident.`;

  const resp = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = resp.content.find(b => b.type === 'text')?.text ?? '{}';
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim());
  } catch {
    return { decision: 'human-review', confidence: 'low', reason: 'Parser failure → defaulted to human-review.', suggested_human_action: 'Read the raw report in admin/safety.' };
  }
}

// ── Discord ────────────────────────────────────────────────────────────

const COLOR = {
  dismiss: 0x9E9E9E,
  warn: 0xFFB300,
  restrict: 0xFF7043,
  ban: 0xC62828,
  'human-review': 0xE53935,
};

async function post(report, decision, action) {
  const embed = {
    title: `${decision.decision.toUpperCase()} — ${report.category ?? 'report'} from ${report.reporter_first_name ?? '?'}`,
    color: COLOR[decision.decision] ?? 0x9E9E9E,
    fields: [
      { name: 'Reporter',    value: `${report.reporter_first_name ?? '?'} @ ${report.reporter_school ?? '?'}`, inline: true },
      { name: 'Reported',    value: `${report.reported_first_name ?? '?'} @ ${report.reported_school ?? '?'}`, inline: true },
      { name: 'Severity',    value: report.severity ?? '?', inline: true },
      { name: 'Category',    value: report.category ?? '?', inline: true },
      { name: 'Bot decision', value: decision.decision, inline: true },
      { name: 'Confidence',  value: decision.confidence, inline: true },
      { name: 'Reason',      value: (report.reason ?? '—').slice(0, 1000), inline: false },
      { name: 'Details',     value: '```\n' + (report.details ?? '—').slice(0, 800) + '\n```', inline: false },
      { name: 'Bot rationale', value: decision.reason?.slice(0, 600) ?? '—', inline: false },
      { name: 'Suggested human action', value: decision.suggested_human_action?.slice(0, 400) ?? '—', inline: false },
      { name: 'Action taken', value: action, inline: false },
      { name: 'Report ID',   value: `\`${report.id}\``, inline: false },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Safety triage' },
  };
  // Anything that's not auto-dismissed gets a ping.
  const ping = decision.decision === 'dismiss' && action.startsWith('auto-dismissed') ? null : '@here new safety report needs review';
  await fetch(DISCORD_HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: ping, embeds: [embed] }),
  }).catch(() => {});
}

// ── Main ───────────────────────────────────────────────────────────────

(async () => {
  for (const k of ['HAVENIQ_ADMIN_TOKEN', 'ANTHROPIC_API_KEY', 'DISCORD_WEBHOOK_URL']) {
    if (!process.env[k]) { console.error('Missing', k); process.exit(1); }
  }

  let payload;
  try { payload = await bot('GET', '/bot-admin/pending-reports'); }
  catch (err) {
    console.error('[safety-triage] backend fetch failed:', err.message);
    await fetch(DISCORD_HOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [{
        title: '🚨 Safety triage — backend unreachable',
        description: '```' + err.message.slice(0, 1500) + '```',
        color: 0xD32F2F, timestamp: new Date().toISOString(),
        footer: { text: 'Safety triage • critical bot, fix ASAP' },
      }] }),
    }).catch(() => {});
    process.exit(1);
  }
  console.log(`${payload.count} open report(s)`);

  let processed = 0;
  for (const report of payload.reports.slice(0, MAX_PER_RUN)) {
    try {
      const decision = await classify(report);
      let action = 'escalated to human';
      if (decision.decision === 'dismiss' && decision.confidence === 'high') {
        await bot('POST', `/bot-admin/report/${report.id}/dismiss`, { reason: decision.reason });
        action = 'auto-dismissed';
      } else {
        await bot('POST', `/bot-admin/report/${report.id}/escalate`, {
          suggested_action: decision.decision,
          reason: decision.reason,
        });
      }
      await post(report, decision, action);
      console.log(`  [${report.id.slice(0, 8)}] ${decision.decision} (${decision.confidence}) → ${action}`);
      processed++;
    } catch (err) {
      console.error(`  [${report.id?.slice(0, 8)}] failed:`, err.message);
    }
  }
  console.log(`Done — ${processed}/${payload.count} processed.`);
})().catch(err => { console.error(err); process.exit(1); });
