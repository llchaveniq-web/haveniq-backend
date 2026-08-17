/**
 * First-line message content moderation.
 *
 * Deliberately CONSERVATIVE so it doesn't punish normal student chat:
 *   - BLOCK → refuse to deliver. Only egregious, low-false-positive content:
 *             unambiguous slurs, explicit sexual solicitation, threats of
 *             violence.
 *   - FLAG  → deliver the message but record it for founder review. Used for
 *             scam signals (gift cards, crypto, "sight unseen") that are
 *             suspicious but sometimes legitimate — a human should look, but
 *             we don't block a real conversation.
 *   - ALLOW → normal.
 *
 * This is a SERVER-SIDE backstop that can't be bypassed by a custom client.
 * It does NOT replace user report/block — it's a first line, not the only line.
 * Adults swear; we do NOT block or flag ordinary profanity (that would flood
 * the review queue and frustrate real users).
 */

// Egregious — refuse delivery. Word-boundaried, with light obfuscation tolerance.
//
// The threat rules used to have NO subject-gating on the bare-verb pattern and
// included words with heavy benign idiomatic use in exactly the context this
// app puts people in (arranging to meet up). That meant real messages between
// real matched students were being deleted and logged as threats:
//   "I'll shoot you a text when I'm heading over"   (texting idiom)
//   "I'll find you outside the dining hall at 7"    (literally the point of matching)
//   "that 8am is gonna kill you lol" / "the walk up that hill will kill you"
//                                                    (impersonal subject, hyperbole)
//   "I'd never want to hurt you, just being honest about the noise thing"
//                                                    (negated — the OPPOSITE of a threat)
//   "I'll beat you to it"                            (racing idiom)
// `shoot` and `find` are dropped entirely — both have such high benign-idiom
// rates in a meetup context that even gating them to an "I'll ___" subject
// still false-positives (see the first two examples above, both "I'll ...").
// `kill`/`hurt`/`beat` move from the ungated bare-verb rule into the
// subject-gated "I'll/I will ___ you" rule below, so hyperbole and negation
// (no "I'll" immediately before the verb) no longer trips them. This is a
// real tradeoff — a threat phrased without "I'll" or using "shoot"/"find"
// alone is no longer caught by this layer — but this filter was never the
// only line (see the file header): user report/block still exists, and
// blocking normal conversation on every "I'll find you at the library" was
// actively breaking the exact thing this app exists to enable.
const BLOCK_RULES = [
  // Unambiguous slurs.
  { category: 'hate', re: /\b(n[i1]gg(?:er|a)s?|f[a@]gg?(?:ot)?s?|tr[a@]nn(?:y|ies)|k[i1]kes?|ch[i1]nks?|sp[i1]cs?|wetbacks?|retard(?:ed|s)?)\b/i },
  // Explicit sexual solicitation / harassment.
  { category: 'sexual', re: /\b(send|show|want|gimme|give me|got any|trade)\b[^.?!]{0,18}\b(nudes?|naked\s?pics?|d[i1]ck\s?pics?|nipples?)\b/i },
  { category: 'sexual', re: /\b(send|trade|drop)\b[^.?!]{0,6}\bnudes?\b/i },
  // Threats of violence — words rare enough as benign idioms that no
  // subject-gating is needed even in a meetup-heavy chat context. "beat up"
  // needs both word orders: "beat you up" (the natural spoken order) and
  // "beat up you" — a single "beat up ... you" pattern only caught the
  // second, so "I'll beat you up" was slipping through as allowed.
  { category: 'threat', re: /\b(rape|murder|stab)\b[^.?!]{0,6}\b(you|u|ya|yourself|ur family)\b/i },
  { category: 'threat', re: /\bbeat\b[^.?!]{0,6}\b(you|u|ya|yourself|ur family)\b[^.?!]{0,4}\bup\b/i },
  { category: 'threat', re: /\bbeat up\b[^.?!]{0,6}\b(you|u|ya|yourself|ur family)\b/i },
  // Threats of violence — words WITH real benign-idiom use ("kill" as
  // hyperbole, "hurt" negated, "beat" as "beat you to it"), so these only
  // block when directly attributed to the sender ("I'll"/"I will"/"I'm
  // gonna" immediately before the verb) — that rules out impersonal
  // subjects ("that hill will kill you") and negation ("I'd never want to
  // hurt you", which has no "I'll"/"I will" immediately before "hurt").
  { category: 'threat', re: /\bi(?:'ll| will| am gonna| ?ll| gonna|m gonna)\b[^.?!]{0,6}\b(kill|hurt|rape|end)\b[^.?!]{0,6}\b(you|u|ya)\b/i },
  // "find" alone isn't gated in ANY form — "I'll find you outside the
  // dining hall" is exactly the kind of thing this app exists to make
  // people say. But "find you" chained to a SECOND violent verb ("find you
  // and hurt you", "find you then kill you") is a real compound threat
  // construction, not a meetup — the second verb is what makes it
  // unambiguous, so this one doesn't need an "I'll" gate either.
  { category: 'threat', re: /\bfind\b[^.?!]{0,10}\b(you|u|ya)\b[^.?!]{0,15}\b(kill|hurt|rape|beat|end)\b/i },
];

// Suspicious but sometimes legitimate — deliver, but log for review.
const FLAG_RULES = [
  { category: 'scam', re: /\bgift\s?cards?\b/i },
  { category: 'scam', re: /\b(bitcoin|crypto(?:currency)?|btc|usdt|ethereum|western union|wire\s?transfer)\b/i },
  { category: 'scam', re: /\b(sight unseen|before (?:you )?(?:see|view|tour)\b|without (?:seeing|viewing|touring))\b/i },
];

// Self-harm / crisis language. NOT abuse — never blocked, never added to the
// moderation queue. When detected, the send route attaches supportive
// resources (988, Crisis Text Line) to the response so the sender sees them.
// Tight patterns so a false positive just shows a caring card (low harm) and
// ordinary venting ("this is killing me", "I'm so stressed") doesn't trip it.
const CRISIS_RULES = [
  /\b(kill(?:ing)?\s+myself|end(?:ing)?\s+my\s+life|take\s+(?:my\s+)?(?:own\s+)?life|want(?:ing)?\s+to\s+die|wanna\s+die|better\s+off\s+dead|suicidal|commit(?:ting)?\s+suicide|don'?t\s+want\s+to\s+(?:live|be\s+here|exist)|kms)\b/i,
  /\b(cut(?:ting)?\s+myself|self[-\s]?harm|hurt(?:ing)?\s+myself|harm(?:ing)?\s+myself)\b/i,
];

// Broader threat SIGNAL detector — used ONLY to decide whether to page a
// human for review (services/checkinSafety.js, on roommate check-in/pulse
// notes), never to block or delete anything a user wrote. That's a
// deliberately different bar than BLOCK_RULES above: a check-in note is
// often a THIRD-PARTY report ("my roommate said he will hurt you if we
// stay") with no first-person "I'll" to gate on, and unlike deleting
// someone's own message, a false positive here just costs a founder a few
// seconds reviewing a Discord ping — while a false negative could mean a
// genuine safety report goes unseen. So this stays subject-agnostic, the
// way BLOCK_RULES' threat rules used to be before that caused real
// messages to be deleted (see the comment above).
const THREAT_SIGNAL_RULES = [
  /\b(kill|rape|murder|stab|shoot|beat up|hurt)\b[^.?!]{0,6}\b(you|u|ya|yourself|ur family|him|her|them)\b/i,
];

function detectThreatSignal(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  const t = text.normalize('NFKC');
  return THREAT_SIGNAL_RULES.some((re) => re.test(t));
}

function screenMessage(text) {
  if (typeof text !== 'string' || !text.trim()) return { action: 'allow', category: null, crisis: false };
  const t = text.normalize('NFKC');
  const crisis = CRISIS_RULES.some(re => re.test(t));
  for (const rule of BLOCK_RULES) {
    if (rule.re.test(t)) return { action: 'block', category: rule.category, crisis };
  }
  for (const rule of FLAG_RULES) {
    if (rule.re.test(t)) return { action: 'flag', category: rule.category, crisis };
  }
  return { action: 'allow', category: null, crisis };
}

// Supportive resources surfaced to a sender whose own message signals crisis.
// US-focused; the message is still delivered — this is care, not moderation.
const CRISIS_SUPPORT = {
  crisis: true,
  title: 'You matter, and you\'re not alone.',
  message: 'If things feel heavy right now, you don\'t have to carry it by yourself. The 988 Suicide & Crisis Lifeline is free, confidential, and available 24/7. Your campus counseling center can help too. If you\'re in immediate danger, call 911.',
  lifeline: '988',
  textLine: { keyword: 'HOME', number: '741741' },
};

module.exports = { screenMessage, detectThreatSignal, CRISIS_SUPPORT };
