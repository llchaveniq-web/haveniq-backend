// ─── Matching-engine stress test ─────────────────────────────────────────
//
// Generates N synthetic students with realistic, correlated quiz answers,
// runs every unique pairing through the compatibility engine, and reports
// the score distribution + block rates + sanity checks.
//
// Pure QA — touches nothing in production. Run:  node scripts/stress-test-matching.js [N]
//
// What a healthy result looks like:
//   • zero NaN / crashes
//   • hard blocks fire (smoking / sleep dealbreakers → 0%)
//   • a real spread of scores (std dev well above 0 — not everyone pinned
//     at one value), mean somewhere in the middle band
//   • matches land across every tier, not all bunched in one

const QUESTIONS = require('../src/data/quizQuestions');
const { calculateCompatibility, generateWhyMatched } = require('../src/services/scoring');

const N = Number(process.argv[2]) || 200;

// Spread each question across one of three latent factors, so generated
// students vary in 3 independent dimensions (not a single rank order).
const factorOf = {};
QUESTIONS.forEach((q, i) => { factorOf[q.id] = i % 3; });

const rand  = () => Math.random();
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// One student: three latent leans in [0,1]; each answer is that question's
// factor lean mapped onto its option range, plus ±1 index of noise.
function makeStudent() {
  const lean = [rand(), rand(), rand()];
  const answers = {};
  for (const q of QUESTIONS) {
    const n = q.options.length;
    const base  = lean[factorOf[q.id]] * (n - 1);
    const noise = (rand() - 0.5) * 2;
    answers[q.id] = clamp(Math.round(base + noise), 0, n - 1);
  }
  return answers;
}

const students = Array.from({ length: N }, makeStudent);

let pairs = 0, hardBlocked = 0, softBlocked = 0, nanCount = 0;
const scores = [];
const tiers  = { exceptional: 0, strong: 0, good: 0, moderate: 0, low: 0 };
const hist   = new Array(10).fill(0);
let sampleWhy = null;

for (let i = 0; i < N; i++) {
  for (let j = i + 1; j < N; j++) {
    const r = calculateCompatibility(students[i], students[j]);
    pairs++;
    if (typeof r.finalPct !== 'number' || Number.isNaN(r.finalPct)) { nanCount++; continue; }
    if (r.isHardBlocked) hardBlocked++;
    if (r.isSoftBlocked) softBlocked++;
    scores.push(r.finalPct);
    const s = r.finalPct;
    if      (s >= 90) tiers.exceptional++;
    else if (s >= 80) tiers.strong++;
    else if (s >= 70) tiers.good++;
    else if (s >= 60) tiers.moderate++;
    else              tiers.low++;
    hist[Math.min(9, Math.floor(s / 10))]++;
    if (!sampleWhy && s >= 80 && !r.isHardBlocked) {
      sampleWhy = generateWhyMatched(r.breakdown, s);
    }
  }
}

const sorted   = [...scores].sort((a, b) => a - b);
const mean     = scores.reduce((a, b) => a + b, 0) / scores.length;
const median   = sorted[Math.floor(sorted.length / 2)];
const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
const std      = Math.sqrt(variance);

console.log(`\n  HavenIQ matching stress test — ${N} students, ${pairs.toLocaleString()} pairings\n`);
console.log(`  Score distribution`);
for (let b = 9; b >= 0; b--) {
  const lo = b * 10, hi = b === 9 ? 100 : b * 10 + 9;
  const count = hist[b];
  const bar = '#'.repeat(Math.round((count / pairs) * 180));
  console.log(`   ${String(lo).padStart(3)}-${String(hi).padStart(3)}%  ${bar} ${count}`);
}
console.log(`\n  mean ${mean.toFixed(1)}%   median ${median}%   min ${sorted[0]}%   max ${sorted[sorted.length - 1]}%   std dev ${std.toFixed(1)}`);
console.log(`\n  Tiers`);
console.log(`   exceptional (90+)   ${tiers.exceptional}`);
console.log(`   strong (80-89)      ${tiers.strong}`);
console.log(`   good (70-79)        ${tiers.good}`);
console.log(`   moderate (60-69)    ${tiers.moderate}`);
console.log(`   low (<60)           ${tiers.low}`);
console.log(`\n  Blocks`);
console.log(`   hard-blocked pairs  ${hardBlocked}  (${((hardBlocked / pairs) * 100).toFixed(1)}%)`);
console.log(`   soft-blocked pairs  ${softBlocked}  (${((softBlocked / pairs) * 100).toFixed(1)}%)`);
if (sampleWhy) console.log(`\n  Sample "why matched":  ${sampleWhy}`);

// ── Sanity checks ────────────────────────────────────────────────────────
// v8 replaced hard-zero blocks with dealbreaker CAPS (ceilings, score preserved,
// not erased), so isHardBlocked is always false by design. Validate the CAP that
// replaced it instead: a smoker × non-smoker pair must be capped below the feed
// floor (drops out) even when otherwise identical.
const capBase = students[0];
const nonSmoker = { ...capBase, 51: 0 };
const smoker    = { ...capBase, 51: 3 };
const capProbe  = calculateCompatibility(nonSmoker, smoker).finalPct;

const checks = [
  ['No NaN / crashes',          nanCount === 0],
  ['Dealbreaker caps fire (smoker×non-smoker → ≤40)', capProbe <= 40],
  ['Soft blocks fire',          softBlocked > 0],
  ['Healthy spread (std > 6)',  std > 6],
  ['Mean not pinned (35-85)',   mean > 35 && mean < 85],
  ['Spans 4+ tiers',            Object.values(tiers).filter(v => v > 0).length >= 4],
  ['No score outside 0-100',    sorted[0] >= 0 && sorted[sorted.length - 1] <= 100],
];
console.log(`\n  Sanity checks`);
let allPass = true;
for (const [name, ok] of checks) {
  if (!ok) allPass = false;
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`\n  ${allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}\n`);
process.exit(allPass ? 0 : 1);
