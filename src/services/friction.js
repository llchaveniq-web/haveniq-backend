'use strict';

// ─── Friction forecast (server-side) ──────────────────────────────────────
//
// "Here's where you'll clash, and the exact words to fix it — before you sign
// the lease." This is the differentiating half of the matching wedge, and it
// was DARK: the client `predictFriction` needs BOTH users' answers, but the feed
// (correctly) never ships another student's raw answer sheet, so it ran on {}
// and returned nothing for every real match. This computes it where the data
// actually lives — the feed query has both answer sets — and ships only the
// derived forecast (mechanism + script), same disclosure level as "why matched".
//
// Deterministic: each detector fires only on a real >=2-notch gap on a specific
// question BOTH answered. Ported faithfully from the app's services/matchReasons
// predictFriction (keep the two in lockstep if the copy changes).

// Flatten the stored wire shape ({type:'option',index} | {type:'scale',value} |
// bare N | "N") to { qid: index }. Mirrors scoring.flatten.
function flatten(answers) {
  const flat = {};
  if (!answers || typeof answers !== 'object') return flat;
  const num = (x) => {
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
    return null;
  };
  for (const [k, v] of Object.entries(answers)) {
    let n = num(v);
    if (n === null && v && typeof v === 'object') {
      n = num(v.index);
      if (n === null) n = num(v.value);
    }
    if (n !== null) flat[k] = n;
  }
  return flat;
}

const idx = (flat, qid) => (typeof flat[qid] === 'number' ? flat[qid] : null);

// Each detector: (a, b) are the two answer indices for its question, both
// guaranteed non-null. Returns a forecast or null.
const DETECTORS = [
  { dim: 49, fire: (a, b) => Math.abs(a - b) >= 2, make: (a, b) => ({
    id: 'friction_sleep', category: 'sleep', emoji: '🌙',
    title: "You're on different clocks",
    mechanism: "One of you sleeps before 10 PM, the other after midnight. That gap causes noise + light friction during the other person's active hours.",
    mitigation: 'Talk about quiet hours BEFORE move-in. Headphones, blackout curtains, and a "library voice after 10" rule prevent ~80% of sleep-related fights.',
    severity: Math.abs(a - b) >= 3 ? 0.95 : 0.78,
  })},
  { dim: 50, fire: (a, b) => Math.abs(a - b) >= 2, make: (a, b) => ({
    id: 'friction_cleanliness', category: 'cleanliness', emoji: '✨',
    title: 'One of you is tidier than the other',
    mechanism: "One of you cleans constantly, the other when it gets noticeable. The cleaner one will likely feel taken advantage of within 2-3 weeks if you don't name the gap.",
    mitigation: 'Agree on shared-space standards EXPLICITLY (e.g. "dishes done by next morning, counters wiped daily"). Resentment forms from unspoken expectations, not different ones.',
    severity: Math.abs(a - b) >= 3 ? 0.92 : 0.75,
  })},
  { dim: 57, fire: (a, b) => Math.abs(a - b) >= 2, make: (a, b) => ({
    id: 'friction_chores', category: 'chores', emoji: '✅',
    title: "Chores won't split evenly on their own",
    mechanism: "One of you finishes tasks the moment they're due. The other lets them slip until a reminder. This is about follow-through, not about caring, and it predicts dish and laundry friction better than anything else.",
    mitigation: 'Use a chore-rotation tool (HavenIQ has one in Build Profile) instead of "whoever notices does it." Put the reminders somewhere you both can see, so the one who forgets isn\'t the only one keeping track in their head.',
    severity: Math.abs(a - b) >= 3 ? 0.88 : 0.7,
  })},
  { dim: 56, fire: (a, b) => (a <= 1 && b === 2) || (b <= 1 && a === 2), make: () => ({
    id: 'friction_money', category: 'money', emoji: '💰',
    title: 'One of you watches the money, the other tunes it out',
    mechanism: 'One of you tracks shared spending closely. The other tunes out money signals. The tracker will feel like the "responsible one" within a month. That resentment compounds fast.',
    mitigation: "Use Splitwise or HavenIQ's expense tracker from day one. Externalize the math so it's not one person mentally tallying. Auto-split bills via Venmo so nobody has to ask.",
    severity: 0.78,
  })},
  { dim: 51, fire: (a, b) => { const d = Math.abs(a - b); return d >= 1 && d < 3; }, make: () => ({
    id: 'friction_substance', category: 'substance', emoji: '🌿',
    title: "One of you uses at home, the other doesn't",
    mechanism: "One of you uses cannabis/vape at home occasionally; the other doesn't. Smell + smoke residue are the usual flashpoints, not the use itself.",
    mitigation: 'Pre-agree: outdoor only, or windows-open + air-purifier. Set a hard rule before move-in. "We\'ll figure it out" almost never works for this.',
    severity: 0.7,
  })},
  { dim: 48, fire: (a, b) => Math.abs(a - b) >= 2, make: (a, b) => ({
    id: 'friction_guests', category: 'guests', emoji: '🎉',
    title: 'One of you wants people over more',
    mechanism: 'One of you hosts multiple times a week. The other prefers a quiet home. Without an agreement, the quieter roommate will feel like a stranger in their own apartment.',
    mitigation: 'Negotiate a "guest cap," e.g. max 2 nights a week with people over, or one weekend night reserved as quiet. Specifics prevent the "you ALWAYS have people over" fight.',
    severity: Math.abs(a - b) >= 3 ? 0.85 : 0.72,
  })},
  { dim: 60, fire: (a, b) => (a === 0 && b === 3) || (b === 0 && a === 3), make: () => ({
    id: 'friction_repair', category: 'communication', emoji: '🔄',
    title: 'One of you lets things go, the other holds on',
    mechanism: 'One of you accepts apologies fully and moves on. The other says "I\'m fine," but the resentment quietly lingers under the surface. Small conflicts compound instead of clearing.',
    mitigation: 'After any real conflict, do a 24-hour follow-up: "Are we genuinely good, or is there still something there?" Short, explicit, gives the residue-holder permission to keep talking.',
    severity: 0.8,
  })},
];

/**
 * Top-N friction forecasts for a pair, ranked by severity.
 * @param {object} aAnswers  reporter's raw stored answers (wire shape)
 * @param {object} bAnswers  other student's raw stored answers
 * @param {object} [opts]    { suppressDims:number[], n:number }
 *   suppressDims — dims the backend certified as COMPLEMENTARITY (the gap
 *   predicts success there, so it's a "balance" not a fight). Empty at
 *   cold-start; wired for when the deep-matching #2 gate certifies.
 * @returns {Array<{id,category,title,mechanism,mitigation,severity,emoji,dim}>}
 */
function computeFrictions(aAnswers, bAnswers, opts = {}) {
  const A = flatten(aAnswers);
  const B = flatten(bAnswers);
  const suppress = new Set((Array.isArray(opts.suppressDims) ? opts.suppressDims : []).map(Number));
  const n = Number.isFinite(opts.n) ? opts.n : 3;

  const out = [];
  for (const d of DETECTORS) {
    if (suppress.has(d.dim)) continue;
    const a = idx(A, d.dim);
    const b = idx(B, d.dim);
    if (a === null || b === null) continue;
    if (!d.fire(a, b)) continue;
    out.push({ ...d.make(a, b), dim: d.dim });
  }
  out.sort((x, y) => y.severity - x.severity);
  return out.slice(0, n);
}

module.exports = { computeFrictions, _flatten: flatten };
