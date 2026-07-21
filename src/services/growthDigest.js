// ═══════════════════════════════════════════════════════════════════════════
//  Grow loop — weekly growth digest (Loop 3). INFORMATIONAL ONLY.
//
//  A weekly job reads REAL numbers from the DB (signups, quiz completions, users
//  with a real compatibility_scores match, connect_requests sent, referrals
//  created), computes week-over-week deltas and the activation funnel
//  (signup → quiz → match → connect → invite), finds the biggest drop-off, and
//  drafts a short digest for the founder — emailed via Resend and exposed at
//  GET /ops/growth-digest.
//
//  Honesty, hard rules:
//   - Every number is pulled from the DB here; the LLM writes the NARRATIVE
//     around the numbers it is handed and MUST NOT generate, estimate, or
//     round a metric itself (a deterministic draft is used when no key/LLM).
//   - A cohort below WATCH_DIGEST_MIN_COHORT (default 20) is reported as "not
//     enough data yet", never as signal.
//   - This digest takes NO action: it sends nothing to users and changes
//     nothing. No circuit breaker (no user-facing send); a kill switch
//     (WATCH_DIGEST_ENABLED, default OFF) gates when it starts.
// ═══════════════════════════════════════════════════════════════════════════

const poolDefault = require('../db/pool');
const { notDemo } = require('../lib/demoFilter');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = process.env.WATCH_DIGEST_MODEL || 'claude-haiku-4-5-20251001';

// Shared reader: a BLANK env var falls back to the guardrail, not to 0 —
// Number('') is 0, which would silently zero a safety threshold.
const { envNum: num } = require('../lib/envNum');
function cfg() {
  return {
    enabled:   process.env.WATCH_DIGEST_ENABLED === 'true', // default OFF
    minCohort: num(process.env.WATCH_DIGEST_MIN_COHORT, 20),
    email:     process.env.DIGEST_EMAIL || process.env.ADMIN_ALERT_EMAIL || 'llchaveniq@gmail.com',
  };
}

// Real users only — the same eligibility discipline as the rest of the app:
// verified, not banned, not a demo/test account.
const ELIGIBLE = `u.is_verified = TRUE AND COALESCE(u.is_banned, FALSE) = FALSE AND (${notDemo('u.email')})`;

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

// A week-over-week delta with the honesty gate. enoughData=false when neither
// week reaches the cohort floor → the narrative says "not enough data yet".
function weeklyDelta(thisN, lastN, minCohort) {
  const enoughData = Math.max(thisN, lastN) >= minCohort;
  const delta = thisN - lastN;
  const pctChange = lastN > 0 ? Math.round((delta / lastN) * 1000) / 10 : null;
  return { this: thisN, last: lastN, delta, pctChange, enoughData };
}

// Funnel drop-offs between consecutive stages. A transition is only trusted when
// its starting cohort clears the floor. biggestDrop = the largest TRUSTED drop.
function computeFunnelDrops(funnel, minCohort) {
  const drops = [];
  for (let i = 1; i < funnel.length; i++) {
    const from = funnel[i - 1], to = funnel[i];
    const enoughData = from.count >= minCohort;
    const dropPct = from.count > 0 ? Math.round((1 - to.count / from.count) * 1000) / 10 : null;
    drops.push({ from: from.stage, to: to.stage, fromCount: from.count, toCount: to.count, dropPct, enoughData });
  }
  const trusted = drops.filter((d) => d.enoughData && d.dropPct != null);
  const biggestDrop = trusted.length ? trusted.reduce((a, b) => (b.dropPct > a.dropPct ? b : a)) : null;
  return { drops, biggestDrop };
}

// Experiment ideas keyed to WHERE the biggest drop is — concrete, and never
// dependent on inventing a number. Used by the deterministic draft and as the
// grounded menu the LLM is told to choose from.
const EXPERIMENTS_BY_STAGE = {
  quiz: [
    'Shorten the quiz gate: let users see a blurred match preview after the 10 core questions, unlocking full matches on completion.',
    'Add a progress/step counter + "≈10 min" up front so the length feels bounded.',
    'A/B the first question — lead with the most engaging scenario item, not a demographic one.',
  ],
  match: [
    'Trigger the "your matches are ready" email the moment the matcher produces the first row, not on next login.',
    'Guarantee a non-empty matches screen at low volume by widening the score floor for brand-new schools.',
    'Add a one-line "why you two" on each match card to make the first match feel earned.',
  ],
  connect: [
    'Lower the cost of the first reach-out: a one-tap "wave" before a full connect request.',
    'Show mutual-compatibility highlights on the profile to make sending a request feel safe.',
    'Nudge with the connect-request email you already send, but sooner after first match view.',
  ],
  invite: [
    'Surface the referral link at the high-intent moment (right after a match or an accepted connect), not buried in Settings.',
    'Give the invite a concrete reason ("more people at your school = better matches").',
    'Add a school-leaderboard element so early users pull in their friends.',
  ],
};

// Deterministic narrative — always available, uses ONLY the numbers handed in.
function templateNarrative(metrics) {
  const w = metrics.weekly;
  const line = (label, d) => d.enoughData
    ? `${label}: ${d.this} this week vs ${d.last} last (${d.delta >= 0 ? '+' : ''}${d.delta}${d.pctChange != null ? `, ${d.pctChange >= 0 ? '+' : ''}${d.pctChange}%` : ''}).`
    : `${label}: ${d.this} this week vs ${d.last} last — not enough data yet to call a trend.`;

  const moves = [
    line('Signups', w.signups),
    line('Quiz completions', w.quizCompletions),
    line('Connect requests', w.connects),
    line('Referrals', w.referrals),
  ].join(' ');

  const bd = metrics.biggestDrop;
  const dropLine = bd
    ? `Biggest activation drop-off: ${bd.from} → ${bd.to} (${bd.fromCount} → ${bd.toCount}, ${bd.dropPct}% fall).`
    : 'No activation drop-off has enough data behind it yet to single out — keep gathering.';

  const experiments = (bd ? EXPERIMENTS_BY_STAGE[bd.to] : null) || EXPERIMENTS_BY_STAGE.quiz;
  const expText = experiments.slice(0, 3).map((e, i) => `${i + 1}. ${e}`).join('\n');

  return `${moves}\n\n${dropLine}\n\nSuggested experiments:\n${expText}`;
}

// ── LLM narrative — narrative ONLY, never a metric. Best-effort → template. ───
function buildPrompt(metrics) {
  return [
    'You write a weekly growth digest for a roommate-matching startup founder.',
    'You are given REAL metrics computed from the database below. Write 3–5 plain',
    'sentences on what moved this week, name the biggest activation drop-off, and',
    'suggest 2–3 concrete experiments (you may draw from the provided experiment',
    'menu). ABSOLUTE RULE: use ONLY the numbers in this JSON — never invent,',
    'estimate, round, or infer a metric. If a metric is marked enoughData:false,',
    'say "not enough data yet" instead of quoting a trend. No markdown headers.',
    '',
    JSON.stringify({ ...metrics, experimentMenu: EXPERIMENTS_BY_STAGE }, null, 2),
  ].join('\n');
}

async function callAnthropic(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return (j.content || []).find((b) => b.type === 'text')?.text?.trim() || null;
  } catch (e) {
    console.error('[growth-digest] LLM call failed:', e.message);
    return null;
  }
}

async function draftNarrative(metrics) {
  try {
    const llm = await callAnthropic(buildPrompt(metrics));
    if (llm) return { narrative: llm, source: 'llm' };
  } catch { /* fall through */ }
  return { narrative: templateNarrative(metrics), source: 'template' };
}

// ── Real-metric collection (the ONLY place numbers come from) ───────────────
async function collectMetrics(pool, minCohort) {
  // Activation funnel — one pass over the eligible user base. Each stage is
  // "eligible users who reached it" (distinct users), so counts are monotonic.
  const funnelRow = (await pool.query(`
    SELECT
      COUNT(*)::int AS signups,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM quiz_answers qa WHERE qa.user_id = u.id AND qa.completed = TRUE))::int AS quiz,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM compatibility_scores cs WHERE cs.user_a = u.id OR cs.user_b = u.id))::int AS match,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM connect_requests cr WHERE cr.from_user = u.id))::int AS connect,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM referrals r WHERE r.referrer_id = u.id::text))::int AS invite
    FROM users u WHERE ${ELIGIBLE}`)).rows[0] || {};

  const funnel = [
    { stage: 'signup',  count: funnelRow.signups || 0 },
    { stage: 'quiz',    count: funnelRow.quiz || 0 },
    { stage: 'match',   count: funnelRow.match || 0 },
    { stage: 'connect', count: funnelRow.connect || 0 },
    { stage: 'invite',  count: funnelRow.invite || 0 },
  ];
  const { drops, biggestDrop } = computeFunnelDrops(funnel, minCohort);

  // Week-over-week counts for the timestamped events (matches carry no
  // timestamp → reported as a level, not a delta — never faked).
  const win = (col, alias, extra = '') => `
    COUNT(*) FILTER (WHERE ${col} >= NOW() - INTERVAL '7 days' ${extra})::int AS ${alias}_this,
    COUNT(*) FILTER (WHERE ${col} >= NOW() - INTERVAL '14 days' AND ${col} < NOW() - INTERVAL '7 days' ${extra})::int AS ${alias}_last`;

  const signupsW = (await pool.query(`SELECT ${win('u.created_at', 's')} FROM users u WHERE ${ELIGIBLE}`)).rows[0] || {};
  const quizW = (await pool.query(
    `SELECT ${win('qa.updated_at', 'q', "AND qa.completed = TRUE")}
       FROM quiz_answers qa JOIN users u ON u.id = qa.user_id WHERE ${ELIGIBLE}`)).rows[0] || {};
  const connW = (await pool.query(
    `SELECT ${win('cr.created_at', 'c')}
       FROM connect_requests cr JOIN users u ON u.id = cr.from_user WHERE ${ELIGIBLE}`)).rows[0] || {};
  const refW = (await pool.query(
    `SELECT ${win('r.created_at', 'r')}
       FROM referrals r JOIN users u ON u.id::text = r.referrer_id WHERE ${ELIGIBLE}`)).rows[0] || {};

  const weekly = {
    signups:         weeklyDelta(signupsW.s_this || 0, signupsW.s_last || 0, minCohort),
    quizCompletions: weeklyDelta(quizW.q_this || 0, quizW.q_last || 0, minCohort),
    connects:        weeklyDelta(connW.c_this || 0, connW.c_last || 0, minCohort),
    referrals:       weeklyDelta(refW.r_this || 0, refW.r_last || 0, minCohort),
    matchesTotal:    funnelRow.match || 0, // compatibility_scores has no timestamp → level only
  };

  return { funnel, drops, biggestDrop, weekly, minCohort };
}

// ── Store + email ───────────────────────────────────────────────────────────
async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_digests (
      id         BIGSERIAL PRIMARY KEY,
      metrics    JSONB NOT NULL,
      narrative  TEXT,
      source     TEXT,
      emailed_to TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_growth_digests_time ON growth_digests(created_at DESC);
  `).catch((e) => console.error('[growth-digest] ensure table:', e.message));
}

function digestHtml(metrics, narrative) {
  const w = metrics.weekly;
  const row = (label, d) => `<tr><td style="padding:4px 12px 4px 0;color:#75695A;">${label}</td><td style="padding:4px 0;font-weight:600;">${
    d.enoughData ? `${d.this} vs ${d.last} (${d.delta >= 0 ? '+' : ''}${d.delta})` : `${d.this} vs ${d.last} — not enough data yet`}</td></tr>`;
  const funnelRows = metrics.funnel.map((s) => `<tr><td style="padding:2px 12px 2px 0;color:#75695A;">${s.stage}</td><td style="padding:2px 0;font-weight:600;">${s.count}</td></tr>`).join('');
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#F6EEDF;padding:28px 16px;">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;">
      <div style="background:#A33625;padding:22px 28px;"><p style="margin:0;color:#fff;font-size:20px;font-weight:800;">HavenIQ ✦ Weekly growth</p></div>
      <div style="padding:24px 28px;color:#2D2620;font-size:14px;line-height:1.6;">
        <p style="white-space:pre-wrap;margin:0 0 20px;">${narrative.replace(/</g, '&lt;')}</p>
        <p style="margin:0 0 6px;font-weight:700;color:#75695A;text-transform:uppercase;font-size:12px;">This week vs last</p>
        <table style="border-collapse:collapse;margin-bottom:18px;">${row('Signups', w.signups)}${row('Quiz completions', w.quizCompletions)}${row('Connect requests', w.connects)}${row('Referrals', w.referrals)}</table>
        <p style="margin:0 0 6px;font-weight:700;color:#75695A;text-transform:uppercase;font-size:12px;">Activation funnel (eligible users)</p>
        <table style="border-collapse:collapse;">${funnelRows}</table>
        <p style="margin:18px 0 0;color:#75695A;font-size:12px;">Informational only — no action taken, nothing sent to users. Matches carry no timestamp, so that stage is a level, not a weekly delta.</p>
      </div>
    </div></body></html>`;
}

async function defaultSendEmail({ to, subject, text, html }) {
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({ from: 'HavenIQ Growth <noreply@haveniq.org>', to, subject, text, html });
}

// The run. Injectable for tests. Kill-switch gated; best-effort; never throws.
async function runDigest(opts = {}) {
  const pool = opts.pool || poolDefault;
  const c = { ...cfg(), ...(opts.config || {}) };
  const enabled = opts.enabled != null ? opts.enabled : c.enabled;
  const draft = opts.draft || draftNarrative;
  const sendEmail = opts.sendEmail || defaultSendEmail;

  if (!enabled) return { ok: true, enabled: false, skipped: 'disabled' };

  await ensureTable(pool);
  let metrics;
  try { metrics = await collectMetrics(pool, c.minCohort); }
  catch (e) { console.error('[growth-digest] collect failed:', e.message); return { ok: false, reason: 'collect_failed' }; }

  const { narrative, source } = await draft(metrics);

  // Store first so the digest is durable even if the email hiccups.
  await pool.query(
    `INSERT INTO growth_digests (metrics, narrative, source, emailed_to) VALUES ($1,$2,$3,$4)`,
    [JSON.stringify(metrics), narrative, source, c.email],
  ).catch((e) => console.error('[growth-digest] store failed:', e.message));

  let emailed = false;
  try {
    await sendEmail({ to: c.email, subject: 'HavenIQ ✦ Weekly growth digest', text: narrative, html: digestHtml(metrics, narrative) });
    emailed = true;
  } catch (e) { console.error('[growth-digest] email failed:', e.message); }

  return { ok: true, enabled: true, emailed, source, biggestDrop: metrics.biggestDrop, funnel: metrics.funnel };
}

async function latestDigest(pool) {
  try {
    const { rows } = await pool.query('SELECT metrics, narrative, source, emailed_to, created_at FROM growth_digests ORDER BY created_at DESC LIMIT 1');
    return rows[0] || null;
  } catch (e) { console.error('[growth-digest] latest failed:', e.message); return null; }
}

module.exports = {
  cfg, weeklyDelta, computeFunnelDrops, templateNarrative, draftNarrative,
  collectMetrics, runDigest, latestDigest, ensureTable, EXPERIMENTS_BY_STAGE,
};
