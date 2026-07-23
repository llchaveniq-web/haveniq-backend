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

// ─── Severity helpers (mirrored from the app's matchReasons.ts) ────────────
// Kept identical so the preview forecast and the real matched forecast read the
// same number — a pair seeing 0.72 in preview and 0.86 on the match would look
// like a bug even though both were "right".
const r2 = (n) => Math.round(n * 100) / 100;
const clamp01 = (n) => Math.max(0, Math.min(1, n));

/** Non-linear gap → severity: `floor` at a 2-notch gap, `ceil` at 3. */
function gapSev(diff, floor, ceil) {
  const t = clamp01((diff - 2) / 1);
  return r2(floor + (ceil - floor) * Math.pow(t, 0.85));
}

/** Compound a second aggravating factor. Capped so a forecast never reads as a
 *  near-certainty it hasn't earned. */
function amplify(base, present, amt) {
  return r2(Math.min(0.97, base + (present ? amt : 0)));
}

// Each detector: (a, b) are the two answer indices for its OWN question, both
// guaranteed non-null. `A`/`B` are the full flattened answer maps, for the
// detectors that need a second question (contempt amplifiers, mutual
// avoidance). `A` is always the VIEWER, so copy can say "you" vs "they".
// Returns a forecast or null.
const DETECTORS = [
  { dim: 49, fire: (a, b) => Math.abs(a - b) >= 2, make: (a, b) => ({
    id: 'friction_sleep', category: 'sleep', emoji: '🌙',
    title: "You're on different clocks",
    mechanism: "One of you sleeps before 10 PM, the other after midnight. That gap causes noise + light friction during the other person's active hours.",
    mitigation: 'Talk about quiet hours BEFORE move-in. Headphones, blackout curtains, and a "library voice after 10" rule prevent ~80% of sleep-related fights.',
    severity: Math.abs(a - b) >= 3 ? 0.95 : 0.78,
  })},
  // Q50: 0 = spotless … 3 = not a priority. Asymmetric — the TIDIER side (lower
  // Q50) is the one who absorbs it. Festers worse when that person won't raise
  // it: Q62 <= 1 (says yes when they mean no) or Q60 === 3 (says "I'm fine" but
  // the resentment lingers).
  //
  // Q60 === 3 ONLY, deliberately. Index 2 is "need to talk it through more" —
  // that person WANTS to raise it, the opposite tell. Treating index 2 as
  // held-in resentment (the `repair >= 2` this replaced) inflated the severity
  // for pairs whose tidier side is actually the one most likely to speak up.
  { dim: 50, fire: (a, b) => Math.abs(a - b) >= 2, make: (a, b, A, B) => {
    const diff = Math.abs(a - b);
    const iAmTidier  = a < b;
    const tidierSide = iAmTidier ? A : B;
    const assertive  = idx(tidierSide, 62);
    const repair     = idx(tidierSide, 60);
    const tidierAvoids = (assertive !== null && assertive <= 1) || repair === 3;
    return {
      id: 'friction_cleanliness', category: 'cleanliness', emoji: '✨',
      title: 'One of you is tidier than the other',
      mechanism: (iAmTidier
        ? "You keep shared space noticeably tidier. Left unspoken, you're the one who'll feel taken advantage of, usually within 2 to 3 weeks."
        : "They keep shared space noticeably tidier than you. Left unspoken, they're the one who'll start to feel taken advantage of first.")
        + (tidierAvoids ? ' And the tidier one here tends to hold it in rather than raise it, so it builds silently before it ever gets said.' : ''),
      mitigation: 'Agree on shared-space standards EXPLICITLY (e.g. "dishes done by next morning, counters wiped daily"). Resentment forms from unspoken expectations, not different ones.',
      severity: amplify(gapSev(diff, 0.75, 0.9), tidierAvoids, 0.06),
    };
  }},
  { dim: 57, fire: (a, b) => Math.abs(a - b) >= 2, make: (a, b) => ({
    id: 'friction_chores', category: 'chores', emoji: '✅',
    title: "Chores won't split evenly on their own",
    mechanism: "One of you finishes tasks the moment they're due. The other lets them slip until a reminder. This is about follow-through, not about caring, and it predicts dish and laundry friction better than anything else.",
    mitigation: 'Use a chore-rotation tool (HavenIQ has one in Build Profile) instead of "whoever notices does it." Put the reminders somewhere you both can see, so the one who forgets isn\'t the only one keeping track in their head.',
    severity: Math.abs(a - b) >= 3 ? 0.88 : 0.7,
  })},
  // Q56: 0-1 = vigilant (bothered / quietly judging), 2 = avoidance (indifferent,
  // tunes money out), 3 = status (admires the spending, would learn from it).
  // Fires when one side is vigilant and the other is NOT (>= 2).
  //
  // Previously `other === 2` only — so vigilant↔status, the maximum 0↔3 gap on
  // this axis, fired NOTHING. That was the biggest silent miss here: it isn't a
  // mere attention gap, it's a values clash, and it deserves the sharper copy.
  { dim: 56, fire: (a, b) => (a <= 1 && b >= 2) || (b <= 1 && a >= 2), make: (a, b) => {
    const other = a <= 1 ? b : a;
    const status = other === 3;
    return {
      id: 'friction_money', category: 'money', emoji: '💰',
      title: status ? 'You treat money differently' : 'One of you watches the money, the other tunes it out',
      mechanism: status
        ? "One of you keeps a close eye on shared spending; the other spends more freely and aspirationally. The watchful one tends to feel the wasteful-spend sting first — it's the exact thing they said bothers them — and it compounds over rent, groceries, and utilities."
        : 'One of you tracks shared spending closely. The other tunes out money signals. The tracker will feel like the "responsible one" within a month. That resentment compounds fast.',
      mitigation: "Use Splitwise or HavenIQ's expense tracker from day one. Externalize the math so it's not one person mentally tallying. Auto-split bills so nobody has to ask.",
      severity: status ? 0.8 : 0.78,
    };
  }},

  // ── Q14 CONTEMPT ──────────────────────────────────────────────────────────
  // 0 = "I sometimes roll my eyes, sigh, or mock when frustrated", 1 = civil.
  // Gottman's strongest single predictor of a relationship souring. The engine
  // already CREDITED a pair for both ruling contempt out but never DEBITED when
  // one side is prone to it — crediting the positive while never naming the
  // negative is a calibration hole. Fires when EITHER side picked 0.
  { dim: 14, fire: (a, b) => a === 0 || b === 0, make: (a, b) => {
    const both = a === 0 && b === 0;
    const mine = a === 0;
    return {
      id: 'friction_contempt', category: 'communication', emoji: '💢',
      title: both ? "You'd both argue with an edge" : 'One of you argues with an edge',
      mechanism: both
        ? 'You both said you can slip into eye-rolls, sighs, or mockery when frustrated. Contempt is the single strongest predictor of a relationship going bad, and here it could come from either side — so ordinary frustration can turn corrosive faster than you\'d expect.'
        : (mine
          ? "You said you can slip into eye-rolls, sighs, or mockery when frustrated with a roommate. That specific move — contempt — is the strongest known predictor of a relationship souring, so it's the one habit most worth catching early."
          : "They said they can slip into eye-rolls, sighs, or mockery when frustrated with a roommate. That specific move — contempt — is the strongest known predictor of a relationship souring, so it's worth being ready to name it kindly if it shows up."),
      mitigation: 'Set one rule together: no contempt in disagreements — no eye-rolls, no mocking tone, just the actual complaint said straight. When it slips, name it gently ("that felt sharp") and reset. Protecting this one habit matters more than winning any single argument.',
      // Rests on one self-report each: real, but not near-certain.
      severity: both ? 0.9 : 0.8,
    };
  }},

  // ── Q52 OVERNIGHT PARTNERS ────────────────────────────────────────────────
  // 0 = totally fine … 3 = keep it to a minimum. Distinct from Q48 general
  // guests: a partner around most nights reads as a third person moving in.
  // Asymmetric — the LESS tolerant side (higher Q52) is the one who absorbs it.
  { dim: 52, fire: (a, b) => Math.abs(a - b) >= 2, make: (a, b) => {
    const iAmLessOk = a > b;
    return {
      id: 'friction_overnight', category: 'guests', emoji: '🛏️',
      title: "A partner staying over won't land the same for both of you",
      mechanism: iAmLessOk
        ? "You'd want a roommate's partner staying over kept limited; they're more relaxed about it. When a partner is around most nights it can feel like a third person moved in, and you're the one whose space quietly shrinks."
        : "They'd want a partner staying over kept limited; you're more relaxed about it. When a partner is around a lot it can feel to them like a third person moved in, and they're the one whose space quietly shrinks.",
      mitigation: 'Set an overnight norm before move-in: how many nights a week feels okay, plus a quick heads-up when someone\'s staying. An explicit number heads off the "your partner basically lives here" fight, which is one of the most common and one of the most preventable.',
      severity: gapSev(Math.abs(a - b), 0.72, 0.86),
    };
  }},

  // ── Q54 DRINKING AT HOME ──────────────────────────────────────────────────
  // 0 = totally fine … 3 = not comfortable. Distinct from Q51 (smoke / vape /
  // cannabis), which has its own detector. Less-comfortable side bears it.
  { dim: 54, fire: (a, b) => Math.abs(a - b) >= 2, make: (a, b) => {
    const iAmLessOk = a > b;
    return {
      id: 'friction_drinking', category: 'substance', emoji: '🍷',
      title: 'You feel differently about drinking at home',
      mechanism: iAmLessOk
        ? "You'd rather the home stay mostly dry; they're comfortable drinking here. It tends to surface around guests and weekends — and the discomfort is usually about the environment, not the person."
        : "They'd rather the home stay mostly dry; you're comfortable drinking here. It tends to surface around guests and weekends — and the discomfort is usually about the environment, not the person.",
      mitigation: "Name what's okay before move-in: drinking alone vs with guests, how often, and whether the shared space stays clear. A clear line up front beats a tense comment in the moment.",
      severity: gapSev(Math.abs(a - b), 0.64, 0.78),
    };
  }},

  // ── Q62 + Q60 MUTUAL AVOIDANCE ────────────────────────────────────────────
  // Every other detector fires on a DIFFERENCE. This one fires on dangerous
  // SAMENESS: two identically conflict-avoidant people read as a great match,
  // and nothing warns that with no natural raiser, friction just accumulates.
  //
  // Q62: 0 = "say yes anyway", 1 = "half-yes", 2 = "politely decline",
  //      3 = "straight no". Fires ONLY when BOTH are <= 1. If EITHER side can
  //      assert (>= 2) the pair HAS a designated raiser and this must not fire.
  // Amplified when both also bottle it (Q60 === 3). Index 2 is "need to talk it
  // through" — a raiser, not a bottler — so it deliberately does NOT amplify.
  { dim: 62, fire: (a, b) => a <= 1 && b <= 1, make: (a, b, A, B) => {
    const bothBottle = idx(A, 60) === 3 && idx(B, 60) === 3;
    return {
      id: 'friction_mutual_avoidance', category: 'conflict', emoji: '🤐',
      title: "Neither of you is the one who'll bring things up",
      mechanism: bothBottle
        ? "You both tend to say yes when you mean no, and you both tend to hold onto things rather than air them. With no one wired to raise the small stuff and no one quick to let it go, friction doesn't get resolved — it accumulates quietly on both sides until it spills over something minor."
        : "You both tend to say yes when you'd rather say no, so neither of you is the one who naturally brings a problem up early. Small things stay unspoken and build, because each of you is waiting for the other to raise it first.",
      mitigation: 'Since neither of you defaults to speaking up, make it a ritual instead of a moment: a standing 10-minute weekly check-in with one question — "anything building up?" — and take turns going first. The structure does the job your instincts won\'t.',
      severity: bothBottle ? 0.82 : 0.7,
    };
  }},
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
    if (!d.fire(a, b, A, B)) continue;
    // A/B (full flattened maps) are passed so cross-question detectors — the
    // cleanliness amplifier and mutual avoidance — can read a second answer.
    // A is the VIEWER, which is what lets the copy say "you" vs "they".
    out.push({ ...d.make(a, b, A, B), dim: d.dim });
  }
  out.sort((x, y) => y.severity - x.severity);
  return out.slice(0, n);
}

module.exports = { computeFrictions, _flatten: flatten };
