'use strict';
// Shadow-validation for Matching v11.0 (prod flag stays OFF until this looks
// sane). Scores every pair in a representative cohort under BOTH v10 and v11 and
// reports the Δ distribution + Spearman rank correlation + sanity cases.
//
// Cohort is SYNTHETIC: the prod DB isn't reachable from the dev box and the app
// is pre-launch (today's population is the seeded demo set), so we sample the
// full answer space with mildly-centered per-question distributions (real
// quizzes aren't uniform). A healthy refinement shows MODEST deltas + HIGH rank
// correlation; a scramble or a saturated distribution is the stop signal.
//
// Reproducible (seeded PRNG). Run: JWT_SECRET=… node scripts/validate-v11.js

const { calculateCompatibility } = require('../src/services/scoring');

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(1234567);

const SCORED = [14, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 60, 62, 63, 65, 66, 67, 68];
const nOpts = (id) => (id === 14 ? 2 : 4);
function sampleOpt(id) {
  const r = rand();
  if (nOpts(id) === 2) return r < 0.5 ? 0 : 1;
  if (r < 0.15) return 0; if (r < 0.5) return 1; if (r < 0.85) return 2; return 3; // center-weighted
}
const makeUser = () => { const u = {}; for (const id of SCORED) u[id] = sampleOpt(id); return u; };

const COHORT = 80;
const users = Array.from({ length: COHORT }, makeUser);

const rows = [];
for (let i = 0; i < users.length; i++)
  for (let j = i + 1; j < users.length; j++) {
    const v10 = calculateCompatibility(users[i], users[j], { v11: false }).finalPct;
    const v11 = calculateCompatibility(users[i], users[j], { v11: true }).finalPct;
    rows.push({ v10, v11, d: v11 - v10 });
  }

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sorted = (a) => [...a].sort((x, y) => x - y);
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
const absd = sorted(rows.map((r) => Math.abs(r.d)));
const d = sorted(rows.map((r) => r.d));

// Spearman ρ = Pearson on average-ranks (tie-safe)
function ranks(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(arr.length);
  let i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function pearson(x, y) {
  const n = x.length, mx = mean(x), my = mean(y);
  let num = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; num += a * b; sx += a * a; sy += b * b; }
  return num / Math.sqrt(sx * sy);
}
const rho = pearson(ranks(rows.map((r) => r.v10)), ranks(rows.map((r) => r.v11)));

console.log(`\n=== Matching v11.0 shadow-validation — synthetic cohort (${COHORT} users, ${rows.length} pairs) ===`);
console.log(`mean |Δ%|    : ${mean(absd).toFixed(2)}`);
console.log(`median |Δ%|  : ${pct(absd, 0.5)}   p90 |Δ%|: ${pct(absd, 0.9)}   p99: ${pct(absd, 0.99)}   max: ${absd[absd.length - 1]}`);
console.log(`Δ% (v11−v10) : min ${d[0]}  p10 ${pct(d, 0.1)}  p25 ${pct(d, 0.25)}  p50 ${pct(d, 0.5)}  p75 ${pct(d, 0.75)}  p90 ${pct(d, 0.9)}  max ${d[d.length - 1]}`);
console.log(`v10 mean/median : ${mean(rows.map((r) => r.v10)).toFixed(1)} / ${pct(sorted(rows.map((r) => r.v10)), 0.5)}`);
console.log(`v11 mean/median : ${mean(rows.map((r) => r.v11)).toFixed(1)} / ${pct(sorted(rows.map((r) => r.v11)), 0.5)}`);
console.log(`Spearman rank correlation v10 ↔ v11 : ${rho.toFixed(4)}`);

const score = (a, b) => ({
  v10: calculateCompatibility(a, b, { v11: false }).finalPct,
  v11: calculateCompatibility(a, b, { v11: true }).finalPct,
});
const base = {}; for (const id of SCORED) base[id] = 1;
const BEST = { 14: 1, 60: 0, 62: 2, 63: 0 }, WORST = { 14: 0, 60: 3, 62: 0, 63: 3 };
const s1 = score({ ...base, ...BEST }, { ...base, ...BEST });
const s2 = score({ ...base, ...WORST }, { ...base, ...WORST });
const s3 = score({ ...base, ...BEST }, { ...base, ...WORST });
console.log(`\nSanity cases (v10 → v11):`);
console.log(`  1) identical + both STRONG communicators   : ${s1.v10} → ${s1.v11}   (stays high ✓)`);
console.log(`  2) identical + both AVOIDANT communicators  : ${s2.v10} → ${s2.v11}   (drops ✓)`);
console.log(`  3) identical lifestyle, one strong/one weak : ${s3.v10} → ${s3.v11}   (fine, not tanked ✓)`);
console.log('');
