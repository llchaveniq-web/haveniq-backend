// Stress-dimension inference (spec §3) — "good insight with fewer questions".
//
// Turns 3 categorical answers + the pair's communication items into ONE honest,
// pair-specific sentence for the friction forecast. This is the "inferencing"
// point: a 3-item quiz yielding long-instrument insight.
//
// Reuses the same Claude path as the About-You / compat-insight synthesis
// (fetch → /v1/messages → strict JSON), and the same soft-fail policy as
// services/photoSafety.js: never throw, never block.
//
// CONTRACT (spec §4): when `underPressure` is present, `headline` is a REQUIRED
// string. So this NEVER returns null — a Claude outage falls back to the
// deterministic per-pattern sentence below (the pattern is known from the matrix
// without any model). Same shape as services/personality.js's fallbackProfile.
// The model makes the sentence pair-specific; it is not load-bearing for the
// contract.

const { stripDashes } = require('../lib/textStyle');

// Deterministic, honestly-hedged fallback per pattern. Framed as an early read,
// never as certainty (spec §3). These are what ships when Claude is unavailable.
const FALLBACK_HEADLINES = {
  pursue_withdraw:
    'When things get tense, one of you will want to talk it out right away and the other will need to step away first. That gap is the single thing worth naming before you move in.',
  both_suppress:
    "You both tend to go quiet under stress, so nothing looks wrong until it is. Worth agreeing now on how you'll raise the small stuff.",
  reactive_suppress:
    'Under stress one of you gets short and the other keeps it in, which is how small things bank up quietly. Naming it early is most of the fix.',
  recovery_mismatch:
    'After a hard day one of you needs silence and the other needs to talk it out. Not a dealbreaker, just worth planning for.',
  complementary:
    'Your styles under stress look like they fit. Still worth agreeing early on what each of you needs on a bad day.',
};

const GENERIC_HEADLINE =
  'Worth talking about how each of you handles a bad day before you move in.';

function fallbackHeadline(pattern) {
  return FALLBACK_HEADLINES[pattern] || GENERIC_HEADLINE;
}

const PROMPT_RULES = `You are writing ONE sentence for a college roommate-matching app's "under pressure" forecast.

You are given how two students say they behave when stressed, plus how they handle conflict.

Write ONE sentence (max 40 words) that:
  - names the SPECIFIC gap or fit between THESE two styles, in plain language
  - is framed as an EARLY READ, not a prediction or a verdict
  - is honest about risk without being alarming. Never say "incompatible" or "won't work"
  - is warm and direct, like a friend who noticed something. Second person ("you", "they")
  - never invents anything not implied by the styles given
  - is NOT a dealbreaker claim. This is a thing to name, not a reason to walk away

Respond ONLY with JSON, no markdown:
{ "headline": "<one sentence>" }`;

/**
 * Build the pair-specific headline. NEVER throws, NEVER returns null.
 *
 * @param {object} p
 * @param {object} p.styles   { 65:{a,b}, 66:{a,b}, 67:{a,b} } — resolved style names
 * @param {string|null} p.pattern  machine tag from scoreStress()
 * @param {number} p.score    0-100 underPressure score
 * @returns {Promise<string>} one sentence, always
 */
async function buildStressHeadline({ styles = {}, pattern = null, score = null } = {}) {
  const fallback = fallbackHeadline(pattern);

  const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY ?? '').replace(/[^!-~]/g, '');
  if (!ANTHROPIC_KEY) return fallback;

  const describe = (qid, label) => {
    const s = styles[qid];
    return s ? `${label}: person A = ${s.a}, person B = ${s.b}` : null;
  };
  const lines = [
    describe(65, 'When overwhelmed at home'),
    describe(66, 'What they need after a rough day'),
    describe(67, 'In a disagreement'),
  ].filter(Boolean);

  // No shared stress answers ⇒ nothing pair-specific to say ⇒ deterministic.
  if (lines.length === 0) return fallback;

  const prompt = `${PROMPT_RULES}

The two students:
${lines.join('\n')}
Detected pattern: ${pattern || 'none'}
Under-pressure fit score: ${score == null ? 'unknown' : `${score}/100 (100 = lowest risk)`}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[stress-insight] Anthropic', r.status, t.slice(0, 200));
      return fallback;
    }
    const j = await r.json();
    const text = (j.content || []).find((b) => b.type === 'text')?.text ?? '{}';
    let payload;
    try {
      payload = JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim());
    } catch { return fallback; }

    const h = typeof payload.headline === 'string' ? payload.headline.trim() : '';
    if (!h) return fallback;
    return stripDashes(h.slice(0, 320));
  } catch (err) {
    console.error('[stress-insight] failed:', err.message);
    return fallback;
  }
}

module.exports = { buildStressHeadline, fallbackHeadline, FALLBACK_HEADLINES };
