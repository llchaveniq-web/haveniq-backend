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
// Cloudflare credentials for auto-rollback when a deploy goes bad.
// Both must be set or rollback is skipped (manual Discord alert only).
const CF_API_TOKEN  = env('CLOUDFLARE_API_TOKEN');
const CF_ACCOUNT_ID = env('CLOUDFLARE_ACCOUNT_ID');
const CF_PROJECT    = env('CLOUDFLARE_PAGES_PROJECT') || 'haveniq-app';

// ── Error burst tracking ──────────────────────────────────────────────
// Counts errors per "bundle hash" (extracted from the user's URL referer
// or stack trace). When a single bundle hits THRESHOLD errors within
// WINDOW_MS, we trigger an automatic Cloudflare Pages rollback to the
// previous production deployment.
//
// Rationale: most bugs only surface AFTER a bad deploy. The first 1-3
// users who load the bad bundle hit errors; we detect the burst, roll
// back, and users 4+ download the previous (working) bundle. The bot's
// auto-fix still ships a forward fix, but rollback buys 5-10 min of
// safety while that fix is in CI.
const errorBurst = new Map(); // bundleHash → { count, firstAt, rolledBack }
const BURST_THRESHOLD = 5;
const BURST_WINDOW_MS = 5 * 60 * 1000;
const BURST_CLEANUP_MS = 30 * 60 * 1000;

function bundleHashFromReport(report) {
  // Sentry-style: extract `index-<hash>.js` from stack or url.
  const sources = [
    String(report.url || ''),
    String(report.stack || '').slice(0, 4000),
  ].join(' ');
  const m = sources.match(/index-([a-f0-9]{16,})\.js/i);
  return m ? m[1] : 'unknown';
}

async function tryAutoRollback(bundleHash) {
  if (!CF_API_TOKEN || !CF_ACCOUNT_ID) {
    return { attempted: false, reason: 'CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set' };
  }
  try {
    // List deployments — most recent first
    const listRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${CF_PROJECT}/deployments?per_page=20`,
      { headers: { Authorization: `Bearer ${CF_API_TOKEN}` }, signal: AbortSignal.timeout(15_000) }
    );
    if (!listRes.ok) {
      const t = await listRes.text().catch(() => '');
      return { attempted: true, success: false, reason: `list failed: ${listRes.status} ${t.slice(0, 200)}` };
    }
    const listJson = await listRes.json();
    const deployments = listJson.result || [];
    // Find the current production deployment (alias contains 'production' or it's most recent with environment=production)
    const production = deployments.find((d) => d.environment === 'production');
    const previousProduction = deployments.find((d) =>
      d.environment === 'production' && d.id !== production?.id && d.id !== (production?.aliases || []).join(',')
    );
    if (!previousProduction) {
      return { attempted: true, success: false, reason: 'no previous production deployment found' };
    }
    // Rollback — POST to rollback endpoint
    const rollbackRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${CF_PROJECT}/deployments/${previousProduction.id}/rollback`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${CF_API_TOKEN}` },
        signal: AbortSignal.timeout(20_000),
      }
    );
    if (!rollbackRes.ok) {
      const t = await rollbackRes.text().catch(() => '');
      return { attempted: true, success: false, reason: `rollback failed: ${rollbackRes.status} ${t.slice(0, 200)}` };
    }
    return {
      attempted: true,
      success: true,
      rolledBackTo: previousProduction.id,
      bundleHash,
    };
  } catch (err) {
    return { attempted: true, success: false, reason: `exception: ${err.message}` };
  }
}

async function trackBurstAndMaybeRollback(report) {
  // Self-healing stale-bundle crashes must NOT count toward auto-rollback.
  // They originate from old tabs running PRE-deploy JS that immediately
  // auto-reloads onto the fresh bundle; the CURRENT deploy is fine. Counting
  // them risks a FALSE rollback of a good deploy (worst case: reverting the
  // very fix those stale tabs are missing, re-breaking everyone). Only an
  // error that persisted on a freshly loaded bundle is a real burst signal.
  if (report && report.selfHealing === true && report.persistedAfterReload !== true) {
    return { burstDetected: false, skipped: 'self_healing_stale_bundle' };
  }
  const bundleHash = bundleHashFromReport(report);
  const now = Date.now();
  let entry = errorBurst.get(bundleHash);

  // Reset stale entries
  if (entry && (now - entry.firstAt) > BURST_CLEANUP_MS) {
    entry = null;
  }
  if (!entry) {
    entry = { count: 0, firstAt: now, rolledBack: false };
  }
  entry.count += 1;
  errorBurst.set(bundleHash, entry);

  // Trigger rollback only ONCE per bundle, when threshold crossed within window
  const withinWindow = (now - entry.firstAt) <= BURST_WINDOW_MS;
  const overThreshold = entry.count >= BURST_THRESHOLD;
  if (!entry.rolledBack && withinWindow && overThreshold) {
    entry.rolledBack = true;
    const result = await tryAutoRollback(bundleHash);
    // Discord alert regardless of success
    if (DISCORD_HOOK) {
      const color = result.success ? 0xE67E22 : 0xC0392B;
      const title = result.success
        ? `🔁 AUTO-ROLLBACK fired — bundle ${bundleHash.slice(0, 8)}`
        : `🚨 ERROR BURST — bundle ${bundleHash.slice(0, 8)} (rollback ${result.attempted ? 'FAILED' : 'SKIPPED'})`;
      fetch(DISCORD_HOOK, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            title,
            description: `${entry.count} errors from this bundle in <${Math.round((now - entry.firstAt) / 1000)}s. ` +
              (result.success
                ? `Cloudflare rolled back to previous production deployment. New users will get the OLD (working) bundle while bot ships a forward fix.`
                : `Rollback could NOT be performed. ${result.reason ?? '(no reason)'}`),
            color,
            fields: [
              { name: 'Bundle hash', value: '`' + bundleHash + '`', inline: false },
              { name: 'Rollback target', value: result.rolledBackTo ? '`' + result.rolledBackTo + '`' : '—', inline: true },
              { name: 'Action needed', value: result.success
                ? 'NONE — auto-recovery in motion. Verify Cloudflare dashboard shows the previous deployment as production.'
                : 'Manually roll back at: https://dash.cloudflare.com/?to=/:account/pages/view/' + CF_PROJECT, inline: false },
            ],
            timestamp: new Date().toISOString(),
            footer: { text: 'Auto-rollback • protects user #N from user #1\'s deploy' },
          }],
        }),
      }).catch(() => {});
    }
    return { burstDetected: true, ...result };
  }
  return { burstDetected: false, count: entry.count, threshold: BURST_THRESHOLD };
}

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

SELF-HEAL SIGNALS (set by the client ErrorBoundary — trust these):
  likelyStaleBundle:    ${report.likelyStaleBundle === true}
  selfHealing:          ${report.selfHealing === true}    (a tab running OLD cached JS hit this; the client auto-reloaded to a fresh bundle, which resolves it)
  persistedAfterReload: ${report.persistedAfterReload === true}    (the error happened AGAIN on a fresh bundle — this is a REAL live bug)

CRITICAL TRIAGE RULE: a stale-bundle self-heal is NOT a live bug. The shipped code is fine; an old open tab simply ran pre-deploy JS and auto-reloaded. So:
  - If selfHealing is true → severity "low", bug_class "stale_bundle_self_heal", fix_eligible false. Do NOT propose a code fix; there is nothing to fix in the current bundle. Note it is a self-healing stale-bundle event.
  - ONLY if persistedAfterReload is true should a hooks/#310/#300/chunk error be treated as real and actionable (severity high). That means it crashed on the freshly-loaded bundle too.

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
  "bug_class":     "null_guard" | "missing_import" | "typo" | "web_platform_short_circuit" | "hooks_violation" | "stale_bundle_self_heal" | "logic" | "config" | "other",
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
  // Founder explicitly wants the bot to attempt fixes even when Claude
  // hedges on confidence. We dispatch when the bug class is in our
  // allowlist OR when severity is HIGH/CRITICAL. Health check +
  // auto-revert is the safety net if a fix ships wrong.
  const inAllowlist = FIX_ELIGIBLE_BUG_CLASSES.has(triage.bug_class);
  const highSeverity = ['high', 'critical'].includes((triage.severity || '').toLowerCase());
  if (!inAllowlist && !highSeverity) return false;
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
      // STEP 1 — Burst tracking + auto-rollback. Runs FIRST and in parallel
      // with triage because rollback latency matters: every second the bad
      // bundle stays live is another user potentially hitting the bug.
      const burstP = trackBurstAndMaybeRollback(report);
      const triage = await callClaudeTriage(report);
      const fixDispatched = await dispatchAutoFix(triage, report);
      const burst = await burstP;
      await postDiscord(report, triage, fixDispatched);
      console.log(`[direct-report] processed: ${triage.severity} ${triage.bug_class} ${triage.likely_file} burst=${burst.burstDetected ? `ROLLED-BACK=${burst.success}` : `count=${burst.count}/${burst.threshold}`}`);
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

// ── reportServerError(input) ──────────────────────────────────────────
// Lets backend routes feed server-side errors into the same triage
// pipeline that frontend errors use. Without this, server 500s that the
// frontend handles gracefully (showing a dialog instead of crashing) slip
// past the bot entirely — the user sees "Upload failed" but no Discord
// triage fires because no React error was thrown.
//
// Call it from any catch block where you've classified the error as a
// real server bug (not a user error like moderation rejection).
//
//   reportServerError({
//     message: 'Photo upload failed: ' + err.message,
//     stack: err.stack,
//     route: 'POST /users/me/photo',
//     userId: req.user?.id,
//     context: { fileSize: req.file?.size, mimeType: req.file?.mimetype },
//   });
//
// Fire-and-forget. Dedupe + async processing handled internally.
async function reportServerError(input = {}) {
  const report = {
    message: String(input.message || 'Unknown server error').slice(0, 4000),
    stack: String(input.stack || '').slice(0, 8000),
    url: input.route ? `backend://${input.route}` : 'backend://unknown',
    userAgent: 'haveniq-backend',
    componentStack: '',
    context: {
      source: 'backend',
      route: input.route || null,
      userId: input.userId || null,
      ...(input.context || {}),
    },
  };

  // Dedupe via same map
  const fp = fingerprint(report);
  const now = Date.now();
  if (recentReports.has(fp)) return { deduped: true };
  recentReports.set(fp, now + DEDUPE_TTL_MS);

  // Process in background — DO NOT await
  setImmediate(async () => {
    try {
      const triage = await callClaudeTriage(report);
      const fixDispatched = await dispatchAutoFix(triage, report);
      await postDiscord(report, triage, fixDispatched);
      console.log(`[server-error-report] processed: ${triage.severity} ${triage.bug_class} ${triage.likely_file}`);
    } catch (err) {
      console.error('[server-error-report] async processing failed:', err.message);
      if (DISCORD_HOOK) {
        fetch(DISCORD_HOOK, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            embeds: [{
              title: '⚠️ Server error report — triage failed',
              description: 'Backend reported an error but Claude triage failed. Raw report below.',
              color: 0xD32F2F,
              fields: [
                { name: 'Route', value: String(report.url).slice(0, 200), inline: false },
                { name: 'Triage error', value: '```' + String(err.message).slice(0, 500) + '```', inline: false },
                { name: 'Original message', value: '```' + String(report.message).slice(0, 800) + '```', inline: false },
              ],
              timestamp: new Date().toISOString(),
              footer: { text: 'Server error report • triage failure' },
            }],
          }),
        }).catch(() => {});
      }
    }
  });

  return { queued: true };
}

module.exports = router;
module.exports.reportServerError = reportServerError;
