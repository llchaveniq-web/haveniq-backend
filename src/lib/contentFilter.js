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

function screenMessage(text) {
  if (typeof text !== 'string' || !text.trim()) return { action: 'allow', category: null };
  const t = text.normalize('NFKC');
  for (const rule of BLOCK_RULES) {
    if (rule.re.test(t)) return { action: 'block', category: rule.category };
  }
  for (const rule of FLAG_RULES) {
    if (rule.re.test(t)) return { action: 'flag', category: rule.category };
  }
  return { action: 'allow', category: null };
}

module.exports = { screenMessage };
