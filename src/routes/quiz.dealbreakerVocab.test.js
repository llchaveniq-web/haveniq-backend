// Priority-tag lockstep — the invariant that was silently violated.
//
// A student picks up to THREE "what matters most" tags. At scoring time the
// backend unions both users' tags and amplifies the matching questions'
// weights by DEALBREAKER_MULTIPLIER, so their feed is tuned to what they said
// they care about.
//
// The failure mode this file exists to prevent is invisible from every side:
//
//   • routes/users.js accepted 'noise' and 'space'.
//   • scoring.js DEALBREAKER_QUESTIONS defined neither.
//   • calculateCompatibility does `const ids = DEALBREAKER_QUESTIONS[tag];
//     if (ids) ...` — an unknown tag is skipped in silence.
//   • The app offered both as chips.
//
// So a student could spend two of their three priority slots on tags that did
// nothing at all, with no error anywhere, and get matching that was a third as
// tuned as the UI promised. Nothing failed; it just quietly didn't work.
//
// Both directions matter and both are asserted here:
//   API-accepted tag with no question mapping  → silently inert (the bug).
//   Mapped tag the API rejects                 → unreachable, dead config.
//
// Fixed 2026-08 by mapping noise -> Q53 (live and scored) and retiring 'space'
// from the vocabulary, since the only question that would back it (Q70, alone
// time) is staged and deliberately absent from SCORED_IDS. node --test.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_thirty_two_chars_long_xxxx';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Read both vocabularies from source rather than importing, so the test stays
// honest even if either module grows import-time side effects.
function scoringTags() {
  const src = fs.readFileSync(path.join(__dirname, '../services/scoring.js'), 'utf8');
  const block = src.match(/const DEALBREAKER_QUESTIONS = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'DEALBREAKER_QUESTIONS block must be parseable');
  const map = {};
  for (const line of block[1].split('\n')) {
    const m = line.match(/^\s*([a-z]+)\s*:\s*\[([0-9,\s]*)\]/);
    if (m) map[m[1]] = m[2].split(',').map(x => x.trim()).filter(Boolean).map(Number);
  }
  return map;
}

function apiTags() {
  const src = fs.readFileSync(path.join(__dirname, './users.js'), 'utf8');
  const m = src.match(/dealbreakers:\s*v =>[\s\S]*?\[([^\]]*)\]\.includes\(x\)/);
  assert.ok(m, 'users.js dealbreakers vocabulary must be parseable');
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

test('every API-accepted priority tag maps to real questions (no silently inert tags)', () => {
  const mapped = scoringTags();
  const accepted = apiTags();
  const inert = accepted.filter(t => !mapped[t] || mapped[t].length === 0);
  assert.deepEqual(inert, [],
    `these tags are accepted by the API but score nothing, so a student's ` +
    `priority slot is wasted in silence: ${inert.join(', ')}`);
});

test('every mapped tag is reachable through the API (no dead config)', () => {
  const mapped = Object.keys(scoringTags());
  const accepted = apiTags();
  const unreachable = mapped.filter(t => !accepted.includes(t));
  assert.deepEqual(unreachable, [],
    `these tags amplify questions but no client can ever set them: ${unreachable.join(', ')}`);
});

test('the amplified questions are actually scored (non-zero QUESTION_POINTS)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/scoring.js'), 'utf8');
  const pts = src.match(/const QUESTION_POINTS = \{([\s\S]*?)\n\};/);
  assert.ok(pts, 'QUESTION_POINTS must be parseable');
  const scored = new Set();
  for (const line of pts[1].split('\n')) {
    const m = line.match(/(\d+)\s*:\s*([0-9.]+)/);
    if (m && Number(m[2]) > 0) scored.add(Number(m[1]));
  }
  const bad = [];
  for (const [tag, ids] of Object.entries(scoringTags())) {
    for (const id of ids) if (!scored.has(id)) bad.push(`${tag} -> Q${id}`);
  }
  // Amplifying a zero-point question is the same no-op by another route:
  // scoring does `if (pts === 0) continue` before the multiplier is applied.
  assert.deepEqual(bad, [],
    `these mappings point at unscored questions, so amplifying them changes ` +
    `nothing: ${bad.join(', ')}`);
});

test("'noise' resolves to the live studying/working question, not a staged one", () => {
  assert.deepEqual(scoringTags().noise, [53],
    'Q53 is the live, scored noise dimension; Q69 is staged and unscored');
});

test("'space' stays out of the vocabulary until a question actually backs it", () => {
  assert.ok(!apiTags().includes('space'),
    'accepting space again without mapping it would restore the original bug');
  assert.ok(!scoringTags().space,
    'mapping space to the staged Q70 would amplify a question nobody is asked');
});
