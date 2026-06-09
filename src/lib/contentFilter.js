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
const BLOCK_RULES = [
  // Unambiguous slurs.
  { category: 'hate', re: /\b(n[i1]gg(?:er|a)s?|f[a@]gg?(?:ot)?s?|tr[a@]nn(?:y|ies)|k[i1]kes?|ch[i1]nks?|sp[i1]cs?|wetbacks?|retard(?:ed|s)?)\b/i },
  // Explicit sexual solicitation / harassment.
  { category: 'sexual', re: /\b(send|show|want|gimme|give me|got any|trade)\b[^.?!]{0,18}\b(nudes?|naked\s?pics?|d[i1]ck\s?pics?|nipples?)\b/i },
  { category: 'sexual', re: /\b(send|trade|drop)\b[^.?!]{0,6}\bnudes?\b/i },
  // Threats of violence.
  { category: 'threat', re: /\b(kill|rape|murder|stab|shoot|beat up|hurt)\b[^.?!]{0,6}\b(you|u|ya|yourself|ur family)\b/i },
  { category: 'threat', re: /\bi(?:'ll| will| am gonna| ?ll| gonna|m gonna)\b[^.?!]{0,6}\b(find|kill|hurt|rape|beat|end)\b[^.?!]{0,6}\b(you|u|ya)\b/i },
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

module.exports = { screenMessage, CRISIS_SUPPORT };
