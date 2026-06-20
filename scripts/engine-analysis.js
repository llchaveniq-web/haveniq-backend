// ─── Matching-engine deep analysis ──────────────────────────────────────────
// Three questions, answered with the REAL engine constants (no copies):
//   A. WEIGHTS — does the weight distribution implement the stated cohabitation
//      hierarchy, and which questions are weakest (least influence)?
//   B. BLEND   — is the 30% personality blend independent signal, or does it
//      overlap/contradict the 70% clinical score? + an empirical measure of how
//      much it actually reshuffles rankings (who your #1 match is).
//   C. QUESTIONS — framework coverage + structural notes.
//
// Pure QA, no DB. Run: node scripts/engine-analysis.js [N]
// CAVEAT: synthetic data (3 latent factors) over-represents alignment and can't
// reveal REAL question redundancy (the generator imposes its own correlation) —
// structural findings are sound; magnitudes are directional only.

const QUESTIONS = require('../src/data/quizQuestions');
const {
  QUESTION_POINTS, CATEGORIES, calculateCompatibility,
} = require('../src/services/scoring');
const { computePersonalityMatch, calibratePersonality } = require('../src/services/personalityPairing');

const N = Number(process.argv[2]) || 300;
const optN = (id) => (QUESTIONS.find(q => q.id === id)?.options?.length || 4);
const totalMax = Object.values(QUESTION_POINTS).reduce((a, b) => a + b, 0);

console.log(`\n  ENGINE ANALYSIS — ${QUESTIONS.length} questions, total max ${totalMax} pts\n`);

// ── A. WEIGHTS ──────────────────────────────────────────────────────────────
console.log('  A. WEIGHT DISTRIBUTION (share of total possible score)');
const catRows = Object.entries(CATEGORIES).map(([cat, { ids }]) => {
  const pts = ids.reduce((s, id) => s + (QUESTION_POINTS[id] || 0), 0);
  return { cat, pts, pct: Math.round(pts / totalMax * 100), n: ids.length };
}).sort((a, b) => b.pts - a.pts);
for (const r of catRows) {
  console.log(`     ${r.cat.padEnd(14)} ${String(r.pts).padStart(4)} pts  ${String(r.pct).padStart(2)}%  (${r.n} Qs)`);
}

console.log('\n  Cohabitation hierarchy check (stated: Conscientiousness > Agreeableness > Emotional Stability > Extraversion)');
const ocean = { Conscientiousness: 25, Agreeableness: 35, 'Emotional Stability': 45, Extraversion: 15, Openness: 61 };
for (const [trait, id] of Object.entries(ocean)) {
  console.log(`     ${trait.padEnd(20)} Q${id}: ${QUESTION_POINTS[id]} pts`);
}
const ok = QUESTION_POINTS[25] > QUESTION_POINTS[35] && QUESTION_POINTS[35] > QUESTION_POINTS[45] && QUESTION_POINTS[45] > QUESTION_POINTS[15];
console.log(`     → hierarchy holds (25>35>45>15)? ${ok ? 'YES' : 'NO'}`);

console.log('\n  Weakest questions (lowest influence on the score):');
const ranked = Object.entries(QUESTION_POINTS).map(([id, pts]) => ({ id: +id, pts })).sort((a, b) => a.pts - b.pts);
for (const r of ranked.slice(0, 8)) {
  const q = QUESTIONS.find(x => x.id === r.id);
  console.log(`     Q${String(r.id).padStart(2)} ${String(r.pts).padStart(2)}pts (${(r.pts / totalMax * 100).toFixed(1)}%)  ${(q?.text || '').slice(0, 50)}`);
}

// ── B. BLEND — overlap + empirical reshuffle ────────────────────────────────
console.log('\n  B. PERSONALITY BLEND (30%) — overlap with the clinical 70%');
const oceanIds = CATEGORIES.personality.ids; // 15,25,35,45,61
const oceanWeight = oceanIds.reduce((s, id) => s + (QUESTION_POINTS[id] || 0), 0);
console.log(`     OCEAN Qs ${oceanIds.join(',')} are scored in BOTH layers: clinically (${oceanWeight} pts, ${Math.round(oceanWeight / totalMax * 100)}% of clinical) AND fed into the 30% blend → partial double-count.`);
console.log('     Net-new signal from the blend = MBTI complementarity heuristic + DISC matrix (NOT in clinical).');
console.log('     ⚠ TENSION: clinical rewards SIMILAR answers; the MBTI heuristic rewards COMPLEMENTARY (E/I, T/F differ = ideal) — they can pull opposite directions on the same traits. (pairing is pop-psych per its own comment.)');

// Empirical: how often does adding the 30% (OCEAN-derived) blend change a student's #1 match?
function rand() { return Math.random(); }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
const factorOf = {};
QUESTIONS.forEach((q, i) => { factorOf[q.id] = i % 3; });
function makeStudent() {
  const lean = [rand(), rand(), rand()];
  const a = {};
  for (const q of QUESTIONS) {
    const n = q.options.length;
    a[q.id] = clamp(Math.round(lean[factorOf[q.id]] * (n - 1) + (rand() - 0.5) * 2), 0, n - 1);
  }
  return a;
}
function oceanFrom(a) {
  const pct = (id) => Math.round((a[id] ?? 0) / (optN(id) - 1) * 100);
  return { extraversion: pct(15), conscientiousness: pct(25), agreeableness: pct(35), neuroticism: 100 - pct(45), openness: pct(61) };
}
const students = Array.from({ length: N }, makeStudent);
const oceans = students.map(oceanFrom);

let topChanged = 0, deltaSum = 0, deltaCount = 0;
for (let i = 0; i < N; i++) {
  let bestClinId = -1, bestClin = -1, bestBlendId = -1, bestBlend = -1;
  for (let j = 0; j < N; j++) {
    if (i === j) continue;
    const clin = calculateCompatibility(students[i], students[j]).finalPct;
    const pers = computePersonalityMatch({ ocean: oceans[i] }, { ocean: oceans[j] });
    const blended = pers === null ? clin : Math.round(clin * 0.7 + calibratePersonality(pers) * 0.3);
    deltaSum += Math.abs(blended - clin); deltaCount++;
    if (clin > bestClin) { bestClin = clin; bestClinId = j; }
    if (blended > bestBlend) { bestBlend = blended; bestBlendId = j; }
  }
  if (bestClinId !== bestBlendId) topChanged++;
}
console.log(`\n     Empirical (OCEAN-only blend, ${N} students):`);
console.log(`     • avg |blended − clinical| score shift: ${(deltaSum / deltaCount).toFixed(1)} pts`);
console.log(`     • students whose #1 MATCH changes with the blend: ${topChanged}/${N} (${Math.round(topChanged / N * 100)}%)`);
console.log('     NOTE: this is the OCEAN portion only — the real blend ALSO includes the MBTI complementarity layer (unsynthesizable here), so the true reshuffle is AT LEAST this much, likely more.');

// ── C. QUESTION / FRAMEWORK COVERAGE ────────────────────────────────────────
console.log('\n  C. FRAMEWORK / CATEGORY COVERAGE');
for (const r of catRows) {
  console.log(`     ${r.cat.padEnd(14)} ${r.n} Qs`);
}
console.log(`\n  (Real question REDUNDANCY needs live answer data — synthetic correlation is a generator artifact, not reported.)\n`);
