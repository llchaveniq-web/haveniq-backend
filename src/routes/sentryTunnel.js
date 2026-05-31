/**
 * Direct error report endpoint — POST /api/__report
 *
 * Frontend's ErrorBoundary POSTs a plain JSON payload here with the
 * error details. We immediately:
 *   1. Triage with Claude (severity, root cause, file, bug class)
 *   2. Post to Discord with diagnosis
 *   3. Dispatch the GitHub Actions auto-fix workflow if eligible
 *
 * This replaces the Sentry tunnel approach which was hitting Railway's
 * edge WAF on payloads containing the Sentry DSN URL pattern. By
 * sending plain JSON instead of Sentry envelope format, we sidestep
 * every layer that was rejecting the body.
 *
 * Bonus: we no longer depend on Sentry being reachable from the user's
 * browser. iOS Safari Cross-Site Tracking Prevention + ad blockers
 * block sentry.io. They CANNOT block our own backend.
 */

const express = require('express');
const router  = express.Router();

const env = (k) => (process.env[k] ?? '').replace(/[^!-~]/g, '');
const ANTHROPIC_KEY = env('ANTHROPIC_API_KEY');
const DISCORD_HOOK  = env('DISCORD_WEBHOOK_URL');
const GH_FIX_TOKEN  = env('GITHUB_FIX_TOKEN');
const GH_REPO       = env('GITHUB_REPO') || 'llchaveniq-web/haveniq-app';

// Dedupe — same error can fire many times in a row from React's
// reconciliation retries. Cache by fingerprint for 10 min so we don't
// spam Discord or burn Anthropic budget.
const recentReports = new Map();
const DEDUPE_TTL_MS = 10 * 60 * 1000;

function fingerprint(report) {
  const msg = String(report.message || '').slice(0, 200);
  const file = String(report.file || report.filename || '');
  const line = String(report.line || report.lineno || '');
  return `${msg}::${file}::${line}`;
}

const HARD_BLOCKED = [
  /payment|stripe|subscription/i,
  /db\/schema\.sql$/,
  /db\/migrations\//,
  /services\/cloudinary/,
  /services\/email/,
];
const isHardBlocked = (p) => HARD_BLOCKED.some((r) => r.test(p || ''));

const FIX_ELIGIBLE_BUG_CLASSES = new Set([
  'null_guard',
  'missing_import',
  'typo',
  'web_platform_short_circuit',
  'hooks_violation',
]);

async function callClaudeTriage(report) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const prompt = `You are HavenIQ's error triage. A user hit this error in the app. Diagnose it.

ERROR MESSAGE: ${report.message || '(no message)'}
ERROR STACK: ${(report.stack || '(no stack)').slice(0, 3000)}
URL WHEN ERROR FIRED: ${report.url || '(unknown)'}
USER AGENT: ${(report.userAgent || '').slice(0, 200)}
ADDITIONAL CONTEXT: ${JSON.stringify(report.context || {}).slice(0, 1000)}

The HavenIQ codebase is a React Native / Expo Web app. Files are in:
  app/(auth)/*       — sign-in, OTP, email screens
  app/(setup)/*      — profile setup, quiz intro, quiz screens
  app/(tabs)/*       — main tab screens (discover, matches, journal, profile)
  app/match/*        — match detail
  components/*       — shared UI
  stores/*           — zustand stores (authStore, matchStore, quizStore)
  services/*         — api.ts, analytics.ts
  utils/*            — helpers

The stack trace might be MINIFIED. Common React errors:
  Minified React error #310 = "Rendered fewer hooks than expected" (early return between hooks)
  Minified React error #185 = "Maximum update depth exceeded" (setState in render)
  Minified React error #321 = "Invalid hook call" (hook outside component)

Respond ONLY with JSON:
{
  "severity":      "low" | "medium" | "high" | "critical",
  "summary":       "<one short sentence: what's broken>",
  "likely_file":   "<best guess at file path relative to repo root, e.g. 'app/(auth)/verify.tsx'>",
  "likely_line":   <integer or null>,
  "root_cause":    "<2-3 sentences>",
  "bug_class":     "null_guard" | "missing_import" | "typo" | "web_platform_short_circuit" | "hooks_violation" | "logic" | "config" | "other",
  "fix_eligible":  <boolean — true if this is a clear, low-risk one-liner fix>,
  "user_impact":   "<one short sentence: what does the user see?>",
  "proposed_fix":  "<plain-English description of what to change to fix it>"
}

No markdown fence. No explanation outside JSON.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Anthropic ${r.status}: ${txt.slice(0, 200)}`);
  }
  const j = await r.json();
  const text = (j.content || []).find((b) => b.type === 'text')?.text ?? '{}';
  return JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim());
}

async function postDiscord(report, triage, fixDispatched) {
  if (!DISCORD_HOOK) return;
  const color = {
    critical: 0xC0392B, high: 0xE74C3C, medium: 0xE67E22, low: 0xF1C40F,
  }[triage.severity] || 0x95A5A6;

  await fetch(DISCORD_HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: `⚡ Direct triage — ${triage.summary || report.message || 'frontend error'}`,
        description: `**Severity:** ${triage.severity?.toUpperCase() || '?'} · From: ${report.url || '?'}`,
        color,
        fields: [
          { name: 'Root cause', value: (triage.root_cause || '—').slice(0, 1000), inline: false },
          { name: 'Likely file', value: `\`${triage.likely_file || '?'}\`${triage.likely_line ? `:${triage.likely_line}` : ''}`, inline: true },
          { name: 'Bug class', value: triage.bug_class || '?', inline: true },
          { name: 'Proposed fix', value: (triage.proposed_fix || '—').slice(0, 1000), inline: false },
          { name: 'User impact', value: (triage.user_impact || '—').slice(0, 400), inline: false },
          {
            name: fixDispatched ? '⚡ Auto-fix dispatched' : '👤 Manual review',
            value: fixDispatched
              ? 'Triggered GitHub Actions sentry-auto-fix. Expect a PR within ~5 min.'
              : 'No auto-fix dispatched — file is hard-blocked or bug class needs human review.',
            inline: false,
          },
          {
            name: 'Error message',
            value: '```\n' + String(report.message || '').slice(0, 800) + '\n```',
            inline: false,
          },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: 'Direct error report • bypasses Sentry / ad blockers / WAF' },
      }],
    }),
  }).catch(() => {});
}

async function dispatchAutoFix(triage, report) {
  if (!GH_FIX_TOKEN) return false;
  if (!triage.fix_eligible) return false;
  if (!FIX_ELIGIBLE_BUG_CLASSES.has(triage.bug_class)) return false;
  if (isHardBlocked(triage.likely_file)) return false;
  if (!triage.likely_file) return false;

  try {
    const r = await fetch(
      `https://api.github.com/repos/${GH_REPO}/actions/workflows/sentry-auto-fix.yml/dispatches`,
      {
        method:  'POST',
        headers: {
          Authorization: `Bearer ${GH_FIX_TOKEN}`,
          Accept:        'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          ref:    'master',
          inputs: {
            // Pass the direct report context so the auto-fix bot knows
            // what file + bug class to look at. Without an issue id
            // (which we don't have — Sentry wasn't involved), we pass
            // a synthetic identifier.
            webhook_issue_id: `direct:${Date.now()}:${(triage.likely_file || '').slice(0, 50)}`,
          },
        }),
      }
    );
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error(`[direct-report] workflow_dispatch failed ${r.status}: ${txt.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[direct-report] dispatch error:', err.message);
    return false;
  }
}

// ── Main POST handler ──────────────────────────────────────────────────
// Accepts JSON. Returns 200 immediately, processes async. Even if the
// triage fails, we still recorded the report.
router.post('/__report', express.json({ limit: '512kb' }), async (req, res) => {
  const report = req.body || {};
  if (!report.message && !report.stack) {
    return res.status(400).json({ error: 'message or stack required' });
  }

  // Dedupe
  const fp = fingerprint(report);
  const now = Date.now();
  for (const [k, exp] of recentReports) if (exp < now) recentReports.delete(k);
  if (recentReports.has(fp)) {
    return res.status(200).json({ ok: true, deduped: true });
  }
  recentReports.set(fp, now + DEDUPE_TTL_MS);

  // Return immediately
  res.status(200).json({ ok: true, queued: true });

  // Process async
  setImmediate(async () => {
    try {
      const triage = await callClaudeTriage(report);
      const fixDispatched = await dispatchAutoFix(triage, report);
      await postDiscord(report, triage, fixDispatched);
      console.log(`[direct-report] processed: ${triage.severity} ${triage.bug_class} ${triage.likely_file}`);
    } catch (err) {
      console.error('[direct-report] async processing failed:', err.message);
      // Even on triage failure, drop a raw report so we know an error happened
      if (DISCORD_HOOK) {
        fetch(DISCORD_HOOK, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            embeds: [{
              title: '⚠️ Direct error report — triage failed',
              description: 'Frontend reported an error but Claude triage failed. Raw report below.',
              color: 0xD32F2F,
              fields: [
                { name: 'Triage error', value: '```' + String(err.message).slice(0, 500) + '```', inline: false },
                { name: 'Original message', value: '```' + String(report.message || '(none)').slice(0, 800) + '```', inline: false },
                { name: 'URL', value: String(report.url || '?').slice(0, 300), inline: false },
              ],
              timestamp: new Date().toISOString(),
              footer: { text: 'Direct error report • triage failure' },
            }],
          }),
        }).catch(() => {});
      }
    }
  });
});

// Health probe
router.get('/__report/health', (req, res) => {
  res.json({
    ok: true,
    anthropic_set: !!ANTHROPIC_KEY,
    discord_set:   !!DISCORD_HOOK,
    gh_fix_token_set: !!GH_FIX_TOKEN,
  });
});

module.exports = router;
