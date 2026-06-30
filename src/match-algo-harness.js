// match-algo-harness.js — offline harness to eyeball the real matching engine on
// deliberately DISPARATE sample profiles. No DB, no network: it calls the exact
// scoring engine production uses (services/scoring.calculateCompatibility).
//
// Run:  node src/match-algo-harness.js
//
// NOTE on answer shape: the engine's flatten() accepts the wire shape this
// harness builds — { type:'option', index } — directly (it reads v.index), as
// well as { type:'scale', value } and bare numbers. So toAnswers() needs no
// adjustment; we keep the realistic wire shape.

const { calculateCompatibility } = require('./services/scoring');

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
console.log('\nNote: complementaryDims / convergingDims are [] here by design — no');
console.log('certified shapes exist offline (cold-start), so the engine emits none.\n');
