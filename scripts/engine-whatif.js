// ─── Matching-engine WHAT-IF simulator ──────────────────────────────────────
// Models PROPOSED engine changes against the CURRENT engine on synthetic data,
// WITHOUT touching production. Two proposals:
//   1. LIFESTYLE UP — re-weight the daily-living questions (cleanliness, sleep,
//      guests, money, etc.) so mild frictions actually count.
//   2. BLEND DE-DUP — score OCEAN once (clinical only), drop the OCEAN-driven
//      personality blend, so a partly-redundant/pop-psych layer stops deciding
//      #1 matches.
// Reports distribution shift + how often a student's #1 match changes.
// Pure QA, no DB. Run: node scripts/engine-whatif.js [N]
// CAVEAT: synthetic data is directional only — use to SEE the shape of a change,
// not to set final weights (that needs real paired-outcome data).

const QUESTIONS = require('../src/data/quizQuestions');
const { QUESTION_POINTS, calculateCompatibility } = require('../src/services/scoring');
const { computePersonalityMatch, calibratePersonality } = require('../src/services/personalityPairing');

const N = Number(process.argv[2]) || 300;
const optN = (id) => (QUESTIONS.find(q => q.id === id)?.options?.length || 4);

// ── Proposal 1: lifestyle up ────────────────────────────────────────────────
// Daily-living drivers of real roommate conflict, re-weighted toward their
// actual importance (cleanliness #1). Smoking stays modest — its hard block
// already carries the extreme case.
const PROPOSED = {
  ...QUESTION_POINTS,
  50: 30, // cleanliness  4 → 30
  49: 25, // sleep        5 → 25
  56: 25, // money       20 → 25
  48: 20, // guests       5 → 20
  52: 15, // overnight    5 → 15
  54: 15, // alcohol      5 → 15
  55: 15, // food         5 → 15
  51: 10, // smoking      5 → 10
};
const sum = (w) => Object.values(w).reduce((a, b) => a + b, 0);
const lifeIds = [48, 49, 50, 51, 52, 54, 55, 56];
const lifeShare = (w) => Math.round(lifeIds.reduce((s, id) => s + w[id], 0) / sum(w) * 100);

console.log(`\n  WHAT-IF — current vs proposed engine (${N} synthetic students)\n`);
console.log(`  Lifestyle share of total weight:  current ${lifeShare(QUESTION_POINTS)}%  →  proposed ${lifeShare(PROPOSED)}%`);
console.log(`  (cleanliness Q50: ${QUESTION_POINTS[50]}→${PROPOSED[50]} pts · sleep Q49: ${QUESTION_POINTS[49]}→${PROPOSED[49]})\n`);

// ── synthetic students ──────────────────────────────────────────────────────
function rand() { return Math.random(); }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
const factorOf = {};
QUESTIONS.forEach((q, i) => { factorOf[q.id] = i % 3; });
function makeStudent() {
  const a = {};
  const lean = [rand(), rand(), rand()];
  for (const q of QUESTIONS) a[q.id] = clamp(Math.round(lean[factorOf[q.id]] * (q.options.length - 1) + (rand() - 0.5) * 2), 0, q.options.length - 1);
  return a;
}
function oceanFrom(a) {
  const pct = (id) => Math.round((a[id] ?? 0) / (optN(id) - 1) * 100);
  return { extraversion: pct(15), conscientiousness: pct(25), agreeableness: pct(35), neuroticism: 100 - pct(45), openness: pct(61) };
}
const students = Array.from({ length: N }, makeStudent);
const oceans = students.map(oceanFrom);

// score matrices
function clinical(i, j, weights) { return calculateCompatibility(students[i], students[j], weights ? { weights } : {}).finalPct; }
function blended(i, j) {           // current: clinical + 30% OCEAN blend
  const c = clinical(i, j);
  const p = computePersonalityMatch({ ocean: oceans[i] }, { ocean: oceans[j] });
  return p === null ? c : Math.round(c * 0.7 + calibratePersonality(p) * 0.3);
}
function topMatch(i, fn) { let best = -1, id = -1; for (let j = 0; j < N; j++) { if (i === j) continue; const s = fn(j); if (s > best) { best = s; id = j; } } return id; }

// distribution helper
function dist(fn) {
  const s = []; let hard = 0;
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) { const v = fn(i, j); s.push(v); if (v === 0) hard++; }
  s.sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
  const ex = s.filter(v => v >= 90).length;
  return { mean: mean.toFixed(1), median: s[s.length >> 1], sd: sd.toFixed(1), exPct: Math.round(ex / s.length * 100) };
}

const curDist = dist((i, j) => clinical(i, j));
const propDist = dist((i, j) => clinical(i, j, PROPOSED));
console.log('  Distribution (clinical only):');
console.log(`     current   mean ${curDist.mean}  median ${curDist.median}  std ${curDist.sd}  exceptional(90+) ${curDist.exPct}%`);
console.log(`     proposed  mean ${propDist.mean}  median ${propDist.median}  std ${propDist.sd}  exceptional(90+) ${propDist.exPct}%`);

// #1 match change: current weights vs proposed weights (clinical only)
let wChanged = 0;
for (let i = 0; i < N; i++) if (topMatch(i, j => clinical(i, j)) !== topMatch(i, j => clinical(i, j, PROPOSED))) wChanged++;
console.log(`\n  Proposal 1 (lifestyle up): #1 match changes for ${wChanged}/${N} (${Math.round(wChanged / N * 100)}%) of students`);

// #1 match change: with-blend vs de-duped (clinical only) — what removing the OCEAN blend does
let bChanged = 0;
for (let i = 0; i < N; i++) if (topMatch(i, j => blended(i, j)) !== topMatch(i, j => clinical(i, j))) bChanged++;
console.log(`  Proposal 2 (blend de-dup): #1 match changes for ${bChanged}/${N} (${Math.round(bChanged / N * 100)}%) — i.e. how often the current OCEAN blend is overriding the clinical pick`);

// concrete demo: a moderately-matched pair (kept off the 99 clamp by some
// attachment disagreement) that ALSO has a moderate cleanliness gap.
const A = { 1: 0, 3: 0, 25: 0, 35: 0, 50: 0 };
const B = { 1: 2, 3: 2, 25: 0, 35: 0, 50: 2 }; // differ on attachment + a cleanliness gap (diff 2, no block)
console.log('\n  Concrete case — a moderately-matched pair that also differs on cleanliness (diff 2, no block):');
console.log(`     current  weights: ${calculateCompatibility(A, B).finalPct}%`);
console.log(`     proposed weights: ${calculateCompatibility(A, B, { weights: PROPOSED }).finalPct}%   (the cleanliness gap now actually costs something)\n`);
