// ─── Matching-pipeline bot check ─────────────────────────────────────────
//
// Runs archetypal "bot" roommate pairs through the ENTIRE match brain a student
// experiences — score, dealbreaker caps, the server-side friction forecast,
// confidence / provisional, and the "why matched" copy — and asserts each pair
// produces the right output. Pure QA, touches no production data.
//
//   node scripts/pipeline-check.js
//
// This is the "let bots walk the process before real students do" harness for
// the matching layer. (The CRUD path — signup → quiz upload → feed → connect →
// message → check-in — needs a live DB/token; do that via a real test signup.)

const { calculateCompatibility, generateWhyMatched, topFrictionTopic } = require('../src/services/scoring');
const { computeFrictions } = require('../src/services/friction');

// The 14 scored v8 questions. Q14 (contempt) is 2-option (0-1); the rest 4 (0-3).
const SCORED = [14, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 60, 62, 63];
const cap4 = (v) => Math.max(0, Math.min(3, v));

// A well-answered student: a VARIED answer per question (≥3 distinct values, all
// 14 answered) so confidence reads 1.0 by default. Overrides set specific dims.
function student(overrides = {}) {
  const a = {};
  SCORED.forEach((q, i) => { a[q] = q === 14 ? (i % 2) : (i % 4); });
  for (const [q, v] of Object.entries(overrides)) a[q] = Number(q) === 14 ? Math.min(1, v) : cap4(v);
  return a;
}

// Read the full student-facing output for a pair, exactly as the feed builds it.
function evaluate(A, B) {
  const r = calculateCompatibility(A, B, { dealbreakers: [] });
  const frictions = computeFrictions(A, B, { n: 3 });
  const why = generateWhyMatched(
    r.breakdown, r.finalPct, r.complementaryDims, r.convergingDims, [],
    { capReason: r.capReason, confidence: r.confidence, frictionTopic: topFrictionTopic(A, B) },
  );
  return { score: r.finalPct, confidence: r.confidence, capReason: r.capReason,
           isSoftBlocked: r.isSoftBlocked, isHardBlocked: r.isHardBlocked, frictions, why };
}

// ── Scenarios: [name, A, B, assert(out) -> [ [label, ok], ... ]] ──────────
const FEED_FLOOR = 40;   // matches.js MATCH_MIN_SCORE — below this drops out of the feed

const SCENARIOS = [
  ['Identical twins (same answers)', student(), student(), (o) => [
    ['high score (>80)',        o.score > 80],
    ['full confidence (=1)',    o.confidence === 1],
    ['no friction fires',       o.frictions.length === 0],
    ['not soft-blocked',        !o.isSoftBlocked],
    ['no NaN',                  Number.isFinite(o.score)],
  ]],

  ['Polar opposites (max gap on everything)',
    student({ 48:0,49:0,50:0,51:0,52:0,53:0,54:0,55:0,56:0,57:0,60:0,62:0,63:0,14:0 }),
    student({ 48:3,49:3,50:3,51:2,52:3,53:3,54:3,55:3,56:2,57:3,60:3,62:3,63:3,14:1 }),
    (o) => [
    ['low score (<55)',         o.score < 55],
    ['friction fires',          o.frictions.length > 0],
    ['why names the gap',       /gap|differ|work out|before you|sort|discuss|compare notes/i.test(o.why)],
    ['no NaN',                  Number.isFinite(o.score)],
  ]],

  ['Smoker × non-smoker (Q51: 0 vs 3, else identical)',
    student({ 51:0 }), student({ 51:3 }), (o) => [
    ['capped below feed floor', o.score <= FEED_FLOOR],
    ['cap reason = smoking',    o.capReason === 'smoking'],
    ['soft-blocked flag set',   o.isSoftBlocked === true],
  ]],

  ['Night owl × early bird (Q49: 0 vs 3, else aligned)',
    student({ 49:0 }), student({ 49:3 }), (o) => {
      const sleep = o.frictions.find(f => f.dim === 49);
      return [
        ['sleep friction fires',    !!sleep],
        ['top severity (0.95)',     sleep && sleep.severity === 0.95],
        ['has a concrete script',   sleep && sleep.mitigation.length > 20],
        ['still a real score (>55)', o.score > 55],
      ];
    }],

  ['Thin data (only 3 questions answered each)',
    { 49:1, 50:1, 51:1 }, { 49:1, 50:2, 51:1 }, (o) => [
    ['provisional confidence (<1)', o.confidence < 1],
    ['score scaled down by it',     o.score < 80],
    ['no crash on sparse input',    Number.isFinite(o.score)],
  ]],

  ['Straight-liner (one bot answers everything the same)',
    (() => { const s = {}; SCORED.forEach(q => { s[q] = q === 14 ? 1 : 1; }); return s; })(),
    student(), (o) => [
    ['confidence penalized (<=0.7)', o.confidence <= 0.7],
  ]],
];

// ── Run + report ──────────────────────────────────────────────────────────
console.log('\n  HavenIQ matching-pipeline bot check\n');
let allPass = true;
for (const [name, A, B, check] of SCENARIOS) {
  const out = evaluate(A, B);
  const results = check(out);
  const pass = results.every(([, ok]) => ok);
  if (!pass) allPass = false;
  console.log(`  ${pass ? '✓' : '✗'} ${name}`);
  console.log(`      score ${out.score}%   confidence ${out.confidence}   cap ${out.capReason || '—'}   frictions ${out.frictions.length}`);
  if (out.frictions[0]) console.log(`      top friction: "${out.frictions[0].title}" → ${out.frictions[0].mitigation.slice(0, 70)}…`);
  console.log(`      why: ${out.why.slice(0, 110)}…`);
  for (const [label, ok] of results) console.log(`        ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log('');
}
console.log(allPass ? '  ALL SCENARIOS PASS — the matching pipeline behaves correctly end to end.\n'
                    : '  SOME SCENARIOS FAILED — see above.\n');
process.exit(allPass ? 0 : 1);
