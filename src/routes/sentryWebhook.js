/**
 * Sentry → Backend webhook receiver (Tier 3 fast-path).
 *
 * Sentry POSTs here within ~5-10 seconds of a new issue. We:
 *   1. Return 200 immediately so Sentry doesn't retry
 *   2. Asynchronously: fetch the full issue (stack trace, breadcrumbs)
 *      from Sentry's API
 *   3. Asynchronously: triage with Claude → post diagnosis to Discord
 *      with priority severity
 *   4. Asynchronously: if the bug class + file passes safety gates,
 *      trigger GitHub Actions sentry-auto-fix workflow with the
 *      issue ID so it processes THAT issue immediately (bypassing
 *      the every-15-min cron and the "new issues only" cache check)
 *
 * End-to-end timing target: ~5-7 min from error to production fix
 * for the safe bug subset, ~30 sec to Discord diagnosis for everything.
 *
 * The existing cron-based bot remains as fallback. If this webhook
 * fails or is unreachable, the every-15-min cron catches the issue
 * within 15 min anyway.
 *
 * SETUP:
 *   1. Backend env vars on Railway (add or confirm):
 *      - SENTRY_AUTH_TOKEN     (user-token with project:read, issue:read)
 *      - SENTRY_ORG_SLUG       (e.g. "haveniq")
 *      - SENTRY_WEBHOOK_SECRET (any random string; same value below)
 *      - ANTHROPIC_API_KEY     (already set for openers/explainer)
 *      - DISCORD_WEBHOOK_URL   (the same one the bots use)
 *      - GITHUB_FIX_TOKEN      (PAT with repo + workflow scope, for
 *                               triggering sentry-auto-fix workflow_dispatch)
 *      - GITHUB_REPO           (default: llchaveniq-web/haveniq-app)
 *   2. Sentry → Settings → Integrations → Alerts → Internal Integration
 *      → Add Webhook → URL: https://haveniq-backend-production.up.railway.app/sentry/webhook
 *      → Secret: the SENTRY_WEBHOOK_SECRET value above
 *      → Subscribe to: "issue.created"
 *   3. Sentry → Alerts → New Issue Alert → Action: send to internal
 *      integration created above.
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');

const env = (k) => (process.env[k] ?? '').replace(/[^!-~]/g, '');
const TRIAGE_TIMEOUT_MS = 25_000;

const SENTRY_TOKEN       = env('SENTRY_AUTH_TOKEN');
const SENTRY_ORG         = env('SENTRY_ORG_SLUG');
const SENTRY_WH_SECRET   = env('SENTRY_WEBHOOK_SECRET');
const ANTHROPIC_KEY      = env('ANTHROPIC_API_KEY');
const DISCORD_HOOK       = env('DISCORD_WEBHOOK_URL');
const GH_FIX_TOKEN       = env('GITHUB_FIX_TOKEN');
const GH_REPO            = env('GITHUB_REPO') || 'llchaveniq-web/haveniq-app';

// Idempotency cache — same issue webhook can fire multiple times (Sentry
// retries on non-2xx, plus multiple alert rules can route to the same URL).
// In-memory is fine: at one-issue-at-a-time low scale, deduping just needs
// to outlast the few minutes of fan-out work.
const recentlySeen = new Map(); // issueId → expiresAt
const DEDUPE_TTL_MS = 30 * 60 * 1000;

// Safe-fix allowlist — mirrors scripts/sentry-auto-fix.mjs. Files
// matching any of these patterns are eligible for the auto-fix
// workflow_dispatch. Everything else still gets a Discord diagnosis
// but no auto-fix attempt.
const FIX_ELIGIBLE_PATTERNS = [
  /^app\/\(auth\)\//,            // sign-in, OTP, email screens
  /^app\/\(tabs\)\//,             // main tab screens
  /^app\/match\//,                // match detail
  /^app\/\(setup\)\//,            // setup flow
  /^app\//,                       // any other app screen
  /^components\//,                // shared UI
  /^stores\//,                    // zustand stores
  /^services\//,                  // api / analytics / etc
  /^utils\//,                     // helper utils
  /^routes\//,                    // backend routes
];

const HARD_BLOCKED_PATTERNS = [
  /safety/i,
  /payment|stripe|subscription/i,
  /db\/schema\.sql$/,
  /db\/migrations\//,
  /services\/cloudinary/,
  /services\/email/,
];

function isHardBlocked(filePath) {
  return HARD_BLOCKED_PATTERNS.some((p) => p.test(filePath));
}

// ── Signature verification ─────────────────────────────────────────────
function verifySentrySignature(rawBody, signatureHeader) {
  if (!SENTRY_WH_SECRET) return true; // not configured = accept (dev mode)
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac('sha256', SENTRY_WH_SECRET)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch { return false; }
}

// ── External API helpers ───────────────────────────────────────────────
async function getJson(url, opts = {}, timeoutMs = TRIAGE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`${url} → ${r.status}: ${text.slice(0, 300)}`);
    }
    return await r.json();
  } finally { clearTimeout(t); }
}

async function fetchSentryIssue(issueId) {
  if (!SENTRY_TOKEN) throw new Error('SENTRY_AUTH_TOKEN not set');
  return getJson(`https://sentry.io/api/0/issues/${encodeURIComponent(issueId)}/`, {
    headers: { Authorization: `Bearer ${SENTRY_TOKEN}` },
  });
}

async function fetchSentryEventLatest(issueId) {
  if (!SENTRY_TOKEN) throw new Error('SENTRY_AUTH_TOKEN not set');
  return getJson(`https://sentry.io/api/0/issues/${encodeURIComponent(issueId)}/events/latest/`, {
    headers: { Authorization: `Bearer ${SENTRY_TOKEN}` },
  }).catch(() => null);
}

async function callClaudeTriage({ issue, event }) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  // Reduce the event to just the stack trace + first breadcrumb summary
  // to keep the prompt short. Full payload is huge; Claude doesn't need it.
  const exceptionValues = event?.entries?.find((e) => e.type === 'exception')?.data?.values ?? [];
  const frames = exceptionValues[0]?.stacktrace?.frames ?? [];
  // Sentry returns frames in reverse-cron order (deepest LAST); we want the
  // top of the user's stack — the frames from /app/ closest to the throw.
  const userFrames = frames
    .filter((f) => f.in_app !== false)
    .slice(-6)  // last 6 in-app frames
    .map((f) => `${f.filename}:${f.lineno || '?'} in ${f.function || '?'}`)
    .join('\n');

  const prompt = `You are HavenIQ's Sentry triage. Read the error and respond with a structured diagnosis.

ISSUE TITLE: ${issue.title || issue.metadata?.value || '(no title)'}
ISSUE LEVEL: ${issue.level || 'error'}
CULPRIT: ${issue.culprit || '(unknown)'}
EVENT COUNT: ${issue.count || 1}
USER COUNT: ${issue.userCount || 0}

TOP STACK FRAMES (closest to throw):
${userFrames || '(no in-app frames)'}

PLATFORM: ${issue.platform || event?.platform || 'web'}

Respond ONLY with JSON:
{
  "severity":    "low" | "medium" | "high" | "critical",
  "summary":     "<one short sentence: what's broken>",
  "likely_file": "<best guess at file path relative to repo root, e.g. 'app/(auth)/verify.tsx'>",
  "likely_line": <integer or null>,
  "root_cause":  "<2-3 sentences>",
  "bug_class":   "null_guard" | "missing_import" | "typo" | "web_platform_short_circuit" | "logic" | "config" | "other",
  "fix_eligible": <boolean — is this in the safe auto-fix set (null_guard / missing_import / typo / web_platform_short_circuit)?>,
  "user_impact": "<one short sentence: what does the user see?>"
}

No markdown fence, no explanation outside JSON.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(TRIAGE_TIMEOUT_MS),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Anthropic ${r.status}: ${txt.slice(0, 200)}`);
  }
  const j = await r.json();
  const text = (j.content || []).find((b) => b.type === 'text')?.text ?? '{}';
  return JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim());
}

async function postDiscordDiagnosis(issue, triage, fixDispatched) {
  if (!DISCORD_HOOK) return;
  const colorMap = {
    critical: 0xC0392B, high: 0xE74C3C, medium: 0xE67E22, low: 0xF1C40F,
  };
  const color = colorMap[triage.severity] || 0x95A5A6;
  const fields = [
    { name: 'Root cause', value: (triage.root_cause || '—').slice(0, 1000), inline: false },
    { name: 'Likely file', value: `\`${triage.likely_file || '?'}\`${triage.likely_line ? `:${triage.likely_line}` : ''}`, inline: true },
    { name: 'Bug class', value: triage.bug_class || '?', inline: true },
    { name: 'User impact', value: (triage.user_impact || '—').slice(0, 300), inline: false },
    {
      name: fixDispatched ? '⚡ Auto-fix dispatched' : '👤 Manual review',
      value: fixDispatched
        ? 'Triggered GitHub Actions sentry-auto-fix with this issue. Expect a PR within ~5 min.'
        : isHardBlocked(triage.likely_file || '')
          ? `File is in the hard-blocked list (payment/safety/schema). Fix manually.`
          : !triage.fix_eligible
            ? `Bug class "${triage.bug_class}" requires human judgement.`
            : 'No clear file target — manual review.',
      inline: false,
    },
  ];

  await fetch(DISCORD_HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: `⚡ Tier 3 triage — ${triage.summary || issue.title || 'new Sentry issue'}`,
        url: issue.permalink || undefined,
        description: `**Severity:** ${triage.severity?.toUpperCase() || '?'} · **Project:** ${issue.project?.slug || '?'} · **Issue:** ${issue.shortId || issue.id}`,
        color,
        fields,
        timestamp: new Date().toISOString(),
        footer: { text: 'Sentry webhook • inline triage • ~30 sec from error' },
      }],
    }),
  }).catch(() => {});
}

async function dispatchAutoFix(issueId) {
  if (!GH_FIX_TOKEN) {
    console.warn('[sentry-webhook] GITHUB_FIX_TOKEN not set — skipping auto-fix dispatch');
    return false;
  }
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
          inputs: { webhook_issue_id: String(issueId) },
        }),
      }
    );
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error(`[sentry-webhook] workflow_dispatch failed: ${r.status} ${txt.slice(0, 200)}`);
      return false;
    }
    console.log(`[sentry-webhook] auto-fix dispatched for issue ${issueId}`);
    return true;
  } catch (err) {
    console.error('[sentry-webhook] dispatch error:', err.message);
    return false;
  }
}

// ── Main handler ───────────────────────────────────────────────────────
//
// Returns 200 immediately, fans the actual work out via setImmediate so
// Sentry doesn't time out and Railway doesn't get long-lived requests.
router.post('/webhook', express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }), async (req, res) => {
  const sig = req.headers['sentry-hook-signature'] || req.headers['x-sentry-signature'];
  if (!verifySentrySignature(req.rawBody || JSON.stringify(req.body || {}), sig)) {
    return res.status(401).json({ error: 'invalid signature' });
  }

  // Extract issue id. Sentry's webhook payload shape:
  //   { action: 'created', data: { issue: { id, ... } }, installation, actor }
  const body  = req.body || {};
  const issue = body.data?.issue || body.event || body;
  const issueId = issue?.id || issue?.issue_id;
  if (!issueId) {
    return res.status(400).json({ error: 'no issue id in payload' });
  }

  // Dedupe — clean expired entries opportunistically
  const now = Date.now();
  for (const [k, exp] of recentlySeen) if (exp < now) recentlySeen.delete(k);
  if (recentlySeen.has(String(issueId))) {
    return res.status(200).json({ ok: true, deduped: true });
  }
  recentlySeen.set(String(issueId), now + DEDUPE_TTL_MS);

  // Return immediately
  res.status(200).json({ ok: true, queued: true, issueId });

  // Process asynchronously. Any error here is logged but never propagates
  // back to Sentry; the every-15-min cron is the safety net.
  setImmediate(async () => {
    try {
      const [fullIssue, event] = await Promise.all([
        fetchSentryIssue(issueId).catch(() => issue),
        fetchSentryEventLatest(issueId),
      ]);
      const triage = await callClaudeTriage({ issue: fullIssue, event });

      // Decide whether to dispatch auto-fix workflow
      const fileBlocked = isHardBlocked(triage.likely_file || '');
      const fileEligible = (triage.likely_file || '').length > 0 &&
        FIX_ELIGIBLE_PATTERNS.some((p) => p.test(triage.likely_file)) &&
        !fileBlocked;
      const dispatchOk = triage.fix_eligible &&
        fileEligible &&
        ['null_guard', 'missing_import', 'typo', 'web_platform_short_circuit'].includes(triage.bug_class);

      let fixDispatched = false;
      if (dispatchOk) {
        fixDispatched = await dispatchAutoFix(issueId);
      }

      await postDiscordDiagnosis(fullIssue, triage, fixDispatched);
    } catch (err) {
      console.error('[sentry-webhook] async processing failed:', err);
      // Best-effort error notification to Discord
      if (DISCORD_HOOK) {
        fetch(DISCORD_HOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            embeds: [{
              title: '⚠️ Sentry webhook — async processing failed',
              description: '```' + String(err.message || err).slice(0, 1500) + '```',
              color: 0xD32F2F,
              fields: [{ name: 'Issue ID', value: String(issueId), inline: true }],
              timestamp: new Date().toISOString(),
              footer: { text: 'Cron-based bot will retry within 15 min.' },
            }],
          }),
        }).catch(() => {});
      }
    }
  });
});

// Health probe — lets you verify the route is mounted without firing a
// real triage. curl https://.../sentry/webhook/health
router.get('/webhook/health', (req, res) => {
  res.json({
    ok: true,
    sentry_token_set: !!SENTRY_TOKEN,
    sentry_org_set:   !!SENTRY_ORG,
    webhook_secret_set: !!SENTRY_WH_SECRET,
    anthropic_set:    !!ANTHROPIC_KEY,
    discord_set:      !!DISCORD_HOOK,
    gh_fix_token_set: !!GH_FIX_TOKEN,
    gh_repo:          GH_REPO,
  });
});

module.exports = router;
