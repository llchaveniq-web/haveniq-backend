/**
 * Honesty-flag detector — projection-vs-expression mismatch.
 *
 * Chad's core safety point from 2026-05-26: "People will tell you what
 * they want you to believe. But they'll show you who they really are
 * when they're expressing themselves in social." The full version of
 * that idea reads someone's actual social-media posts and compares to
 * their stated profile, which requires OAuth approvals from Meta /
 * ByteDance / Snap (2-6 weeks per platform, not buildable today).
 *
 * This is the minimal version that's buildable RIGHT NOW: compare what
 * the user wrote in their *bio* (projection — the public-facing
 * narrative) against what they answered in the *quiz* (reflection —
 * forced-choice). Bio-vs-quiz mismatch isn't sociopath detection by
 * any stretch — it's a much milder "is this person aware of how they
 * actually live?" signal. Useful as ONE input for the founder review
 * queue, NEVER user-visible.
 *
 * Returns an array of { dimension, claim, observed, severity } flags.
 * Severity is just 'low' | 'medium' so the founder eyeball-reviewer
 * can sort by attention-needed without it being a scoring engine.
 */

const PATTERNS = [
  // Cleanliness — "I'm clean / tidy / organized" vs relaxed answers.
  {
    dimension: 'cleanliness',
    claimRe:   /\b(super\s+clean|extremely\s+(clean|tidy)|always\s+(clean|tidy|organized)|neat\s*freak|spotless)\b/i,
    // If bio claims very clean but quiz says relaxed/messy.
    isMismatch: (quiz) => quiz?.cleanliness && /relaxed|chaos|messy/i.test(String(quiz.cleanliness)),
    severity:  'medium',
  },
  {
    dimension: 'cleanliness',
    claimRe:   /\b(messy|chill\s+about\s+(mess|cleaning)|don'?t\s+care\s+about\s+cleaning)\b/i,
    // Bio admits messy but quiz claims very tidy.
    isMismatch: (quiz) => quiz?.cleanliness && /very\s+tidy|spotless/i.test(String(quiz.cleanliness)),
    severity:  'low',
  },

  // Sleep — "early bird" vs night owl quiz answer.
  {
    dimension: 'sleep',
    claimRe:   /\b(early\s+(riser|bird)|up\s+at\s+(5|6)\s*(am)?|morning\s+person)\b/i,
    isMismatch: (quiz) => quiz?.sleep && /night\s*owl|after\s+midnight/i.test(String(quiz.sleep)),
    severity:  'medium',
  },
  {
    dimension: 'sleep',
    claimRe:   /\b(night\s*owl|stay\s+up\s+late|insomniac)\b/i,
    isMismatch: (quiz) => quiz?.sleep && /early\s*bird|before\s*10/i.test(String(quiz.sleep)),
    severity:  'low',
  },

  // Substances — claims "I don't drink" / "sober" but quiz says regular drinker.
  {
    dimension: 'substances',
    claimRe:   /\b(sober|don'?t\s+drink|never\s+drink|teetotal)\b/i,
    isMismatch: (quiz) => quiz?.alcohol && /regular|often|daily|heavy/i.test(String(quiz.alcohol)),
    severity:  'medium',
  },

  // Noise — "I'm super quiet" vs lively quiz answer.
  {
    dimension: 'noise',
    claimRe:   /\b(very\s+quiet|super\s+quiet|i\s+like\s+silence|need\s+quiet)\b/i,
    isMismatch: (quiz) => quiz?.noise && /lively|loud|moderate/i.test(String(quiz.noise)),
    severity:  'low',
  },

  // Guests — "I never have people over" vs frequent guests quiz answer.
  {
    dimension: 'guests',
    claimRe:   /\b(rarely\s+have\s+(people|guests)|introvert|don'?t\s+host)\b/i,
    isMismatch: (quiz) => quiz?.guests && /frequently|often/i.test(String(quiz.guests)),
    severity:  'medium',
  },
];

/**
 * Compare bio text + quiz answers; return flag objects describing each
 * mismatch found. Quiz argument is a flat { cleanliness, sleep, ... }
 * object as stored on user_profile_snapshot — caller is responsible for
 * shaping it (this function is dumb and doesn't query the DB).
 */
function detectHonestyFlags({ bio, quiz }) {
  const flags = [];
  if (!bio || typeof bio !== 'string') return flags;

  for (const p of PATTERNS) {
    if (!p.claimRe.test(bio)) continue;
    if (!p.isMismatch(quiz || {})) continue;
    flags.push({
      dimension: p.dimension,
      claim:     bio.match(p.claimRe)?.[0] ?? '',
      observed:  String(quiz?.[p.dimension] ?? '(no quiz answer)'),
      severity:  p.severity,
    });
  }

  return flags;
}

module.exports = { detectHonestyFlags };
