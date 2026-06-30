// match-algo-harness.js — offline harness to eyeball the real matching engine on
// deliberately DISPARATE sample profiles. By default: no DB, no network — it
// calls the exact scoring engine production uses (services/scoring).
//
// Run:  node src/match-algo-harness.js
//       node src/match-algo-harness.js --llm-judge   (optional spot-check, below)
//
// ─── HARD RULE for --llm-judge ───────────────────────────────────────────────
// --llm-judge is a DEV AID, NEVER A GATE. It asks Claude for a one-line "does
// this pairing / score look sane?" read, printed beside the engine result, so a
// human can eyeball obvious nonsense. That is ALL it is:
//   • It NEVER feeds back into scoring and NEVER changes a score.
//   • It NEVER fails the run — any API error is caught and printed inline.
//   • Real cohabitation OUTCOMES decide whether a match was good, not the LLM.
//     An LLM will confidently rate a genuinely bad match as good; treating its
//     opinion as truth would launder a guess into a verdict.
//   • Off by default; the API key comes from env, so normal runs cost nothing.
// ─────────────────────────────────────────────────────────────────────────────
//
// NOTE on answer shape: the engine's flatten() accepts the wire shape this
// harness builds — { type:'option', index } — directly (it reads v.index), as
// well as { type:'scale', value } and bare numbers. So toAnswers() needs no
// adjustment; we keep the realistic wire shape.

const { calculateCompatibility } = require('./services/scoring');

// ─── Optional LLM judge (dev aid — see HARD RULE above) ──────────────────────
const LLM_JUDGE   = process.argv.includes('--llm-judge');
const JUDGE_MODEL = process.env.LLM_JUDGE_MODEL || 'claude-haiku-4-5'; // cheap spot-check

// Ask Claude for a one-line sanity read on a pair + its engine score. Best-effort
// and TOTALLY isolated: returns a short string (never throws), so it can never
// fail the run or touch scoring. No key / any error → a printable note, not a crash.
async function judgePair(profA, profB, score) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return '(no ANTHROPIC_API_KEY — skipped)';
  const render = (p) => Object.entries(p.a).map(([q, idx]) => `Q${q}=${idx}`).join(' ');
  const prompt = [
    'You are spot-checking a roommate-matching engine (NOT deciding anything — a human reads your note).',
    'Two students answered a lifestyle quiz. Option index 0 = low end, 3 = high end of each question; Q14 is 0/1.',
    `Student A (${profA.name}): ${render(profA)}`,
    `Student B (${profB.name}): ${render(profB)}`,
    `The engine scored this pair ${score}/100.`,
    'In ONE blunt sentence: does this pairing make sense, and does the score look about right?',
  ].join('\n');
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: JUDGE_MODEL, max_tokens: 120, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) return `(judge HTTP ${res.status})`;
    const j = await res.json();
    const text = (j.content || []).find(b => b.type === 'text')?.text;
    return text ? text.trim().replace(/\s+/g, ' ').slice(0, 220) : '(empty response)';
  } catch (e) {
    return `(judge error: ${e.message})`;
  }
}

// The 14 SCORED v8 questions (everything else is ignored by the engine), with a
// short label + the meaning of the LOW (0) and HIGH (max) option so the sample
// profiles below are readable. Q14 is the only 2-option item; the rest are 4.
const Q = {
  50: 'cleanliness   (0 spotless        → 3 mess is fine)',
  49: 'bedtime       (0 before 10pm     → 3 after 2am)',
  48: 'hosting       (0 rarely          → 3 several/week)',
  53: 'study env     (0 silent focus    → 3 chaotic ok)',
  55: 'food/kitchen  (0 strict sharing  → 3 free-for-all)',
  54: 'alcohol       (0 never           → 3 heavy)',
  52: 'overnighters  (0 never           → 3 frequent)',
  51: 'smoke@home    (0 never           → 3 regularly)',
  14: 'contempt      (0 contempt-prone  → 1 respectful)',   // 2-option
  57: 'chores/EF     (0 done instantly  → 3 lingers/weekly)',
  60: 'repair recv   (0 accepts apology → 3 holds grudge)',
  63: 'repair init   (0 initiates       → 3 never)',
  62: 'boundaries    (0 sets clearly    → 3 avoids)',
  56: 'money         (0 frugal/vigilant → 3 spendy/status)',
};

// Deliberately disparate archetypes. Each is a compact { qid: optionIndex } map.
// NOTE on confidence: the engine throttles confidence to 0.7 for a near-uniform
// answer vector (≤2 distinct option values across the scored set) to punish
// straight-lining. Realistic students vary their answers, so each profile below
// uses ≥3 distinct values — otherwise even identical twins cap at ~69 (0.7×99).
const PROFILES = [
  { name: 'Monk (tidy early quiet sober)',
    a: { 50:0, 49:0, 48:1, 53:0, 55:1, 54:0, 52:0, 51:0, 14:1, 57:0, 60:1, 63:0, 62:0, 56:2 } },
  { name: 'Monk-twin (identical)',
    a: { 50:0, 49:0, 48:1, 53:0, 55:1, 54:0, 52:0, 51:0, 14:1, 57:0, 60:1, 63:0, 62:0, 56:2 } },
  { name: 'Party animal (messy night-owl host)',
    a: { 50:3, 49:3, 48:3, 53:2, 55:3, 54:3, 52:3, 51:3, 14:0, 57:3, 60:2, 63:3, 62:2, 56:1 } },
  { name: 'Moderate (middle of the road)',
    a: { 50:1, 49:2, 48:1, 53:0, 55:1, 54:2, 52:1, 51:0, 14:1, 57:1, 60:0, 63:2, 62:1, 56:1 } },
  { name: 'Clean night-owl studious (sober)',
    a: { 50:0, 49:3, 48:0, 53:0, 55:1, 54:1, 52:0, 51:0, 14:1, 57:0, 60:0, 63:1, 62:1, 56:1 } },
  { name: 'Tidy social butterfly (light drinker)',
    a: { 50:1, 49:2, 48:2, 53:2, 55:2, 54:2, 52:1, 51:0, 14:1, 57:1, 60:1, 63:1, 62:1, 56:2 } },
  { name: 'Clean quiet SMOKER (else compatible w/ Monk)',
    a: { 50:0, 49:1, 48:0, 53:0, 55:0, 54:1, 52:0, 51:3, 14:1, 57:0, 60:0, 63:1, 62:0, 56:2 } },
  { name: 'Partial profile (only 3 answers → low confidence)',
    a: { 50:1, 49:2, 14:1 } },
];

// Build the realistic wire shape the app sends: { qid: { type:'option', index } }.
function toAnswers(map) {
  const out = {};
  for (const [qid, index] of Object.entries(map)) out[qid] = { type: 'option', index };
  return out;
}

// THE WIRED FUNCTION: score a pair through the real engine.
function scorePair(profA, profB) {
  const r = calculateCompatibility(toAnswers(profA.a), toAnswers(profB.a));
  return {
    score: r.finalPct,
    hardBlocked: r.isHardBlocked,
    complementaryDims: r.complementaryDims,
    convergingDims: r.convergingDims,
    // extra, for the harness report only (not part of the requested return shape):
    _capReason: r.capReason,
    _softBlocked: r.isSoftBlocked,
  };
}

// ── Report ───────────────────────────────────────────────────────────────────
function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

console.log('\n=== HavenIQ matching engine — disparate-profile harness ===\n');
console.log('Scored questions (v8):');
for (const [qid, label] of Object.entries(Q)) console.log(`  Q${pad(qid, 3)} ${label}`);

console.log('\nProfiles:');
PROFILES.forEach((p, i) => console.log(`  [${i}] ${p.name}`));

// Pairwise score matrix.
console.log('\nPairwise finalPct matrix (rows × cols):');
const header = '      ' + PROFILES.map((_, j) => pad(`[${j}]`, 6)).join('');
console.log(header);
for (let i = 0; i < PROFILES.length; i++) {
  let row = pad(`[${i}]`, 6);
  for (let j = 0; j < PROFILES.length; j++) {
    if (i === j) { row += pad('·', 6); continue; }
    const { score } = scorePair(PROFILES[i], PROFILES[j]);
    row += pad(score, 6);
  }
  console.log(row);
}

// Detailed rows for every unordered pair: score, hard block, cap, dims.
console.log('\nPer-pair detail:');
for (let i = 0; i < PROFILES.length; i++) {
  for (let j = i + 1; j < PROFILES.length; j++) {
    const r = scorePair(PROFILES[i], PROFILES[j]);
    const flags = [];
    if (r.hardBlocked) flags.push('HARD-BLOCK');
    if (r._capReason) flags.push(`cap:${r._capReason}`);
    else if (r._softBlocked) flags.push('soft');
    const comp = r.complementaryDims && r.complementaryDims.length ? JSON.stringify(r.complementaryDims) : '[]';
    const conv = r.convergingDims && r.convergingDims.length ? JSON.stringify(r.convergingDims) : '[]';
    console.log(
      `  ${pad(`[${i}]×[${j}]`, 9)} score=${pad(r.score, 4)} ` +
      `hardBlocked=${pad(r.hardBlocked, 5)} ${pad(flags.join(',') || '-', 18)} ` +
      `complementaryDims=${pad(comp, 4)} convergingDims=${conv}`,
    );
  }
}

// Sanity checks that should hold for the real engine.
console.log('\nSanity checks:');
const twin = scorePair(PROFILES[0], PROFILES[1]).score;
const opp  = scorePair(PROFILES[0], PROFILES[2]).score;
const smoke = scorePair(PROFILES[0], PROFILES[6]);
console.log(`  identical twins score ~100        : ${twin}  (${twin >= 95 ? 'PASS' : 'CHECK'})`);
console.log(`  monk vs party animal is low       : ${opp}  (${opp <= 40 ? 'PASS' : 'CHECK'})`);
console.log(`  non-smoker × smoker capped (≤35)   : ${smoke.score} cap=${smoke._capReason}  (${smoke.score <= 35 ? 'PASS' : 'CHECK'})`);
console.log(`  twins beat opposites              : ${twin > opp ? 'PASS' : 'CHECK'}`);
console.log('\nNote: the matrix/detail above is COLD-START — no opts passed, so');
console.log('complementaryDims / convergingDims are [] (the deep-matching layers');
console.log('are inert without certified shapes). The probes below force them on.\n');

// ── PROBES ───────────────────────────────────────────────────────────────────
// Inject the same opts production passes, to make the GATED deep-matching layers
// (#2 complementarity, #6 trajectory, dealbreaker amp, validation multiplier)
// visible on readable profiles. The shapes/drift here are SYNTHETIC — exactly
// what the gate WOULD certify from real outcomes. In production these only exist
// AFTER real move-in/room-change data certifies them; this just shows the wiring
// fires end-to-end, it does not certify anything.
console.log('=== PROBES (synthetic certified shapes — what the gate would emit) ===\n');

const sc = (a, b, opts) => calculateCompatibility(toAnswers(a), toAnswers(b), opts);

// One MID-COMPATIBILITY pair (differ on ~6 dims → score sits in the 50s-60s, so
// there's real headroom for a probe to move it — an identical pair pins at the
// 99 ceiling and hides the effect). No cap triggers (51 both 0, 54 both 1,
// Q50/Q49 gaps stay < the cap thresholds), answer spread ≥3 (conf 1.0). The pair
// differs on Q57 (0 vs 3), Q49 (0 vs 3) and Q50 (0 vs 2) — the dims each probe acts on.
const PX = { 50:0, 49:0, 48:0, 53:0, 55:0, 54:1, 52:1, 51:0, 14:1, 57:0, 60:0, 63:0, 62:0, 56:2 };
const PY = { 50:2, 49:3, 48:2, 53:2, 55:2, 54:1, 52:1, 51:0, 14:1, 57:3, 60:0, 63:0, 62:0, 56:2 };

// (1) #2 COMPLEMENTARITY on chores (Q57). A far-apart chore pair is penalized
// today; a certified complementary shape REWARDS the difference.
const choreLo = PX, choreHi = PY;
const CHORE_COMPLEMENT = { 57: {
  certified: true, type: 'complementarity',
  baseline: { intercept: 0,    coef: { dist: -1 } },
  basis:    { intercept: -1.5, coef: { dist: 3.5, mean: 0, min: 0, max: 0, prod: 0, conv: 0 } },
} };
const c0 = sc(choreLo, choreHi);
const c1 = sc(choreLo, choreHi, { dimensionModels: CHORE_COMPLEMENT });
console.log('(1) #2 complementarity — chore styles opposite (Q57: 0 vs 3):');
console.log(`    cold-start         score=${pad(c0.finalPct, 3)} complementaryDims=${JSON.stringify(c0.complementaryDims)}`);
console.log(`    + certified shape  score=${pad(c1.finalPct, 3)} complementaryDims=${JSON.stringify(c1.complementaryDims)}`);
console.log(`    → difference is now REWARDED (${c0.finalPct} → ${c1.finalPct})\n`);

// (2) #6 TRAJECTORY / projection — bedtimes far apart (Q49: 0 vs 3) but both
// trending toward the middle. A certified project shape scores the FUTURE value.
const bedLo = PX, bedHi = PY;
// Gentle, converging velocities: over the 90-day horizon each moves ~1.5 option
// steps, so they MEET near the middle (gap 3 → ~0) instead of overshooting.
const driftA = { 49: { velocity:  0.5, trend: 'changed', sampleSize: 10 } }; // 0 climbing toward middle
const driftB = { 49: { velocity: -0.5, trend: 'changed', sampleSize: 10 } }; // 3 falling toward middle
const PROJECT_49 = { 49: {
  certified: true, type: 'similarity', project: true,
  baseline: { intercept: 0, coef: { dist: -1 } },
  basis:    { intercept: 0, coef: { dist: -1, mean: 0, min: 0, max: 0, prod: 0, conv: 0 } },
} };
const p0 = sc(bedLo, bedHi);
const p1 = sc(bedLo, bedHi, { dimensionModels: PROJECT_49, driftA, driftB, horizonDays: 90 });
console.log('(2) #6 trajectory/projection — bedtimes opposite (Q49: 0 vs 3) but converging:');
console.log(`    cold-start (snapshot)  score=${pad(p0.finalPct, 3)} convergingDims=${JSON.stringify(p0.convergingDims)}`);
console.log(`    + project shape+drift  score=${pad(p1.finalPct, 3)} convergingDims=${JSON.stringify(p1.convergingDims)}`);
console.log(`    → scored on where they're HEADING (${p0.finalPct} → ${p1.finalPct})\n`);

// (2b) #6 CONVERGENCE term — a conv-weighted shape rewards the closing gap.
const CONV_49 = { 49: {
  certified: true, type: 'similarity', project: false,
  baseline: { intercept: 0, coef: { dist: -1 } },
  basis:    { intercept: 0, coef: { dist: -1, mean: 0, min: 0, max: 0, prod: 0, conv: 2 } },
} };
const v1 = sc(bedLo, bedHi, { dimensionModels: CONV_49, driftA, driftB });
console.log('(2b) #6 convergence term — same drift, conv-weighted shape:');
console.log(`     score=${pad(v1.finalPct, 3)} convergingDims=${JSON.stringify(v1.convergingDims)}\n`);

// (3) DEALBREAKER amplification (×1.75) — a full sleep mismatch (Q49: 0 vs 3)
// hits harder when either roommate flags 'sleep' as what-matters-most.
const slpLo = PX, slpHi = PY;
const d0 = sc(slpLo, slpHi);
const d1 = sc(slpLo, slpHi, { dealbreakers: ['sleep'] });
console.log('(3) dealbreaker amplification — sleep mismatch (Q49: 0 vs 3):');
console.log(`    no flag             score=${pad(d0.finalPct, 3)}`);
console.log(`    + dealbreaker flag  score=${pad(d1.finalPct, 3)} (${d1.finalPct < d0.finalPct ? 'mismatch hits harder ✓' : 'no change'})\n`);

// (4) VALIDATION multiplier (±7.5%) with the HONESTY GATE — only moves when BOTH
// users have a real validation_score; a one-sided signal does nothing.
const m0    = sc(PX, PY);
const mBoth = sc(PX, PY, { validationA: 0.9, validationB: 0.9 });
const mOne  = sc(PX, PY, { validationA: 0.9 });
console.log('(4) behavioral validation multiplier (honesty-gated):');
console.log(`    neutral             score=${pad(m0.finalPct, 3)} mult=${m0.validationMultiplier}`);
console.log(`    both validated 0.9  score=${pad(mBoth.finalPct, 3)} mult=${mBoth.validationMultiplier} (lifts ✓)`);
console.log(`    one-sided (A only)  score=${pad(mOne.finalPct, 3)} mult=${mOne.validationMultiplier} (no change — honesty gate ✓)\n`);

console.log('Probes are SYNTHETIC: hand-built certified shapes/drift show the wiring');
console.log('fires. In production nothing here is certified until real outcomes earn it.\n');

// ── Optional LLM judge (DEV AID — see HARD RULE in the file header) ───────────
// Runs ONLY with --llm-judge. Asks Claude for a one-line sanity read per pair,
// printed beside the engine score. It changes nothing; it's a human-eyeball aid.
if (LLM_JUDGE) {
  (async () => {
    console.log('=== LLM JUDGE (DEV AID — never a gate; real outcomes decide, not the LLM) ===\n');
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('ANTHROPIC_API_KEY not set — skipping. Normal runs cost nothing.\n');
      return;
    }
    console.log(`model: ${JUDGE_MODEL}  (one Claude call per pair; spot-check only)\n`);
    for (let i = 0; i < PROFILES.length; i++) {
      for (let j = i + 1; j < PROFILES.length; j++) {
        const r = scorePair(PROFILES[i], PROFILES[j]);
        // judgePair never throws — a failure prints inline and the loop continues.
        const note = await judgePair(PROFILES[i], PROFILES[j], r.score);
        console.log(`  [${i}]×[${j}] engine=${pad(r.score, 3)} | judge: ${note}`);
      }
    }
    console.log('\nReminder: an LLM will confidently call a bad match good. This note never');
    console.log('feeds back into scoring — real cohabitation outcomes are the only judge.\n');
  })().catch(err => {
    // Belt-and-suspenders: the judge must NEVER fail the run.
    console.log(`\n[llm-judge] skipped after an unexpected error (non-fatal): ${err.message}\n`);
  });
}
