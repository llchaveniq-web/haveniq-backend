'use strict';
// Shadow-validation + weight SWEEP for Matching v11.0 (prod flag stays OFF until
// a set is chosen). Scores a representative cohort under v10 and under several
// candidate v11 category-weight sets, and reports for each: Δ distribution +
// Spearman rank correlation vs v10. Higher ρ = closer to v10's ordering (gentler
// refinement); lower ρ = a bigger, more opinionated re-rank.
//
// Cohort is SYNTHETIC (prod DB not reachable from dev; app pre-launch). Center-
// weighted per-question sampling. Reproducible (seeded PRNG).
// Run: JWT_SECRET=… node scripts/validate-v11.js

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
  if (r < 0.15) return 0; if (r < 0.5) return 1; if (r < 0.85) return 2; return 3;
}
const makeUser = () => { const u = {}; for (const id of SCORED) u[id] = sampleOpt(id); return u; };
const COHORT = 80;
const users = Array.from({ length: COHORT }, makeUser);
const PAIRS = [];
for (let i = 0; i < users.length; i++) for (let j = i + 1; j < users.length; j++) PAIRS.push([users[i], users[j]]);

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sorted = (a) => [...a].sort((x, y) => x - y);
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
function ranks(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(arr.length); let i = 0;
  while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; }
  return r;
}
function pearson(x, y) { const n = x.length, mx = mean(x), my = mean(y); let num = 0, sx = 0, sy = 0; for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; num += a * b; sx += a * a; sy += b * b; } return num / Math.sqrt(sx * sy); }

const v10 = PAIRS.map(([a, b]) => calculateCompatibility(a, b, { v11: false }).finalPct);
const rV10 = ranks(v10);

// Candidate weight sets (communication kept HIGHEST in every one).
const SETS = {
  'A · current (shipped)':  { communication: 0.34, lifestyle: 0.30, control: 0.20, nervous: 0.16 },
  'B · soft control':       { communication: 0.34, lifestyle: 0.33, control: 0.16, nervous: 0.17 },
  'C · lifestyle-preserving':{ communication: 0.35, lifestyle: 0.34, control: 0.16, nervous: 0.15 },
  'D · gentlest':           { communication: 0.34, lifestyle: 0.335, control: 0.165, nervous: 0.16 },
};

console.log(`\n=== v11 weight sweep — synthetic cohort (${COHORT} users, ${PAIRS.length} pairs) ===`);
console.log(`v10 baseline mean/median: ${mean(v10).toFixed(1)} / ${pct(sorted(v10), 0.5)}`);
console.log('set                         mean|Δ|  med|Δ|  p90|Δ|   v11 mean   Spearman ρ');
for (const [name, cw] of Object.entries(SETS)) {
  const v11 = PAIRS.map(([a, b]) => calculateCompatibility(a, b, { v11: true, categoryWeightsV11: cw }).finalPct);
  const absd = sorted(v11.map((v, i) => Math.abs(v - v10[i])));
  const rho = pearson(rV10, ranks(v11));
  console.log(
    `${name.padEnd(27)} ${mean(absd).toFixed(2).padStart(6)}  ${String(pct(absd, 0.5)).padStart(5)}  ${String(pct(absd, 0.9)).padStart(5)}   ${mean(v11).toFixed(1).padStart(7)}      ${rho.toFixed(4)}`);
}

// Sanity cases for the default (shipped) set — confirm the two-class behavior.
const base = {}; for (const id of SCORED) base[id] = 1;
const BEST = { 14: 1, 60: 0, 62: 2, 63: 0 }, WORST = { 14: 0, 60: 3, 62: 0, 63: 3 };
const sc = (a, b) => ({ v10: calculateCompatibility(a, b, { v11: false }).finalPct, v11: calculateCompatibility(a, b, { v11: true }).finalPct });
console.log(`\nSanity (default set, v10 → v11):`);
console.log(`  identical + strong communicators : ${JSON.stringify(sc({ ...base, ...BEST }, { ...base, ...BEST }))}`);
console.log(`  identical + AVOIDANT communicators: ${JSON.stringify(sc({ ...base, ...WORST }, { ...base, ...WORST }))}`);
console.log(`  identical lifestyle, one/one weak : ${JSON.stringify(sc({ ...base, ...BEST }, { ...base, ...WORST }))}`);
console.log('');
