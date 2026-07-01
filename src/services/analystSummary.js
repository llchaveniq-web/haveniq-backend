// ═══════════════════════════════════════════════════════════════════════════
//  The recalibration "analyst" — the ONLY place an LLM touches weight-learning,
//  and even here it does NOT decide anything. The statistics (weightLearning.js)
//  produce the proposed weights, coefficients, and anomaly flags. This module
//  turns that into a plain-English "what changed and why" for the human review
//  queue, plus surfaces the (stat-derived) anomaly flags.
//
//  Best-effort + cheap: one small model call, only when a NEW proposal is
//  enqueued (rare — the analyst job runs on a schedule and dedups). No API key,
//  or any failure → a deterministic template summary. Never blocks or throws.
// ═══════════════════════════════════════════════════════════════════════════

const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = process.env.WEIGHT_ANALYST_MODEL || 'claude-haiku-4-5-20251001';

// Deterministic fallback — always available, no LLM. Describes the biggest
// movers and echoes the anomaly flags in words.
function templateSummary(proposal) {
  const movers = (proposal.signals || [])
    .filter((s) => s.current && s.proposedWeight !== s.current)
    .map((s) => ({ ...s, rel: (s.proposedWeight - s.current) / s.current }))
    .sort((a, b) => Math.abs(b.rel) - Math.abs(a.rel))
    .slice(0, 3);

  const scopeLabel = proposal.scope === 'global' ? 'global weights' : `the ${proposal.scope} layer`;
  const head = proposal.ready
    ? `Proposed recalibration of ${scopeLabel} from ${proposal.decided} decided outcomes.`
    : `Illustrative only — ${scopeLabel} need ${proposal.minN} decided outcomes (have ${proposal.decided}); nothing is actionable yet.`;

  const moverText = movers.length
    ? movers.map((s) => {
        const dir = s.proposedWeight > s.current ? 'up' : 'down';
        const pct = Math.round(Math.abs(s.rel) * 100);
        const r = s.coefficient == null ? 'no clear signal' : `r=${s.coefficient}`;
        return `Q${s.qid} ${dir} ${pct}% (${s.current}→${s.proposedWeight}, agreement↔success ${r}, n=${s.pairN})`;
      }).join('; ')
    : 'No question moved materially from the prior.';

  const anomalyText = (proposal.anomalies || []).length
    ? ` ⚠ ${proposal.anomalies.length} anomaly flag(s): ` + proposal.anomalies.map((a) => `Q${a.qid} (${a.reason})`).join('; ') + '.'
    : '';

  return `${head} ${moverText}.${anomalyText}`;
}

async function callAnthropic(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 320,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return (j.content || []).find((b) => b.type === 'text')?.text?.trim() || null;
  } catch (e) {
    console.error('[weight-analyst] LLM call failed:', e.message);
    return null;
  }
}

function buildPrompt(proposal) {
  const facts = {
    scope: proposal.scope,
    decidedOutcomes: proposal.decided,
    readinessThreshold: proposal.minN,
    actionable: proposal.ready,
    method: proposal.method,
    topSignals: (proposal.signals || []).slice(0, 6).map((s) => ({
      question: s.qid, currentWeight: s.current, proposedWeight: s.proposedWeight,
      agreementToSuccessCorrelation: s.coefficient, pairsWithData: s.pairN,
    })),
    anomalyFlags: proposal.anomalies || [],
  };
  return [
    'You are a statistics analyst for a roommate-matching engine. The NUMBERS below',
    'were computed by a regularized regression — you do NOT decide weights, you only',
    'explain them for a human reviewer. In 2–4 plain-English sentences, say what is',
    'changing and why (cite the correlation r and sample n), and call out any anomaly',
    'flags as cautions. Be honest: if it is not actionable yet, say so. No markdown,',
    'no bullet lists, no invented numbers — use only the JSON facts.',
    '',
    JSON.stringify(facts, null, 2),
  ].join('\n');
}

// Returns { summary, source: 'llm'|'template' }. Never throws.
async function summarize(proposal) {
  const fallback = templateSummary(proposal);
  try {
    const llm = await callAnthropic(buildPrompt(proposal));
    if (llm && llm.length > 0) return { summary: llm, source: 'llm' };
  } catch { /* fall through */ }
  return { summary: fallback, source: 'template' };
}

module.exports = { summarize, templateSummary, buildPrompt };
