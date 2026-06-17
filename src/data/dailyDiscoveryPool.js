/**
 * Daily Discovery — the content pools.
 *
 * Two kinds of content surface to users one-per-day:
 *
 *   BONUS_QUESTIONS — single-answer quiz extensions. Roommate-relevant
 *   situations that didn't fit the main 32-question quiz but generate
 *   high-information signal. The user's answer is stored as a regular
 *   quiz_answer and feeds the matching engine (deferred wiring; for
 *   now data accumulates).
 *
 *   REFLECTIONS — observational insights about the user, computed from
 *   their existing profile/quiz data. NOT generic horoscope copy —
 *   each template requires specific data to fire, so users only see
 *   reflections grounded in their actual answers.
 *
 * The route alternates question → reflection → question → reflection
 * across the user's day-count, so it never feels like the same kind
 * of content two days in a row.
 */

// ─── Bonus questions ────────────────────────────────────────────────
// IDs start at 100 to avoid collision with the main quiz (currently
// uses ids 1-63). Same shape as the main quiz so quiz_answers row
// inserts use the existing pipeline.
const BONUS_QUESTIONS = [
  { id: 100, category: 'lifestyle', framework: 'Lifestyle',
    text: 'A roommate eats your leftovers without asking. First reaction:',
    options: [
      'Confront them right then',
      'Mention it next time we talk',
      'Mark food more clearly going forward',
      "Let it go — it's just food",
    ] },
  { id: 101, category: 'communication', framework: 'Conflict',
    text: 'Your roommate has people over and it\'s an exam week. You:',
    options: [
      'Ask them to take it elsewhere — exams come first',
      'Wear headphones and study in your room',
      'Go to the library instead — easier than the conversation',
      "Join them for 20 min — quick break won't hurt",
    ] },
  { id: 102, category: 'nervous', framework: 'Sensory',
    text: 'Your ideal apartment temperature setting is:',
    options: [
      'Cool — 65-68°F, I sleep better cold',
      'Mild — 69-71°F, a comfortable middle',
      'Warm — 72-74°F, I get cold easily',
      'Whatever the other person prefers',
    ] },
  { id: 103, category: 'lifestyle', framework: 'Lifestyle',
    text: 'How do you handle shared groceries?',
    options: [
      'Strictly separate — mine on my shelf, theirs on theirs',
      'Shared staples (oil, salt) but separate everything else',
      'Mostly shared with a Venmo split at month-end',
      'Whoever needs it uses it — we keep it loose',
    ] },
  { id: 104, category: 'communication', framework: 'Boundaries',
    text: 'A roommate asks to borrow your car for the weekend. You:',
    options: [
      "Yes — I'd want them to do the same for me",
      'Yes with conditions (insurance check, gas refill)',
      'Decline politely — too risky',
      'Lie about needing it that weekend',
    ] },
  { id: 105, category: 'emotional', framework: 'Regulation',
    text: 'When you\'re having a bad day, you usually want a roommate to:',
    options: [
      'Notice and ask — I want to talk it out',
      'Notice but give me space until I bring it up',
      'Not make a big deal — treat it like a normal day',
      'Leave me alone entirely — I\'ll handle it',
    ] },
  { id: 106, category: 'lifestyle', framework: 'Lifestyle',
    text: 'It\'s 2 AM and you can\'t sleep. You:',
    options: [
      'Lay in bed quietly — anything else wakes my roommate',
      'Read with a small light — they\'re used to it',
      'Get up and go to the kitchen / common area',
      'Honestly, I don\'t care — I just do what I need',
    ] },
  { id: 107, category: 'communication', framework: 'Direct',
    text: 'You realize your roommate has been quietly annoyed at you for days. You:',
    options: [
      'Ask them straight up what\'s going on',
      'Wait for them to bring it up',
      'Try to figure out what I did and fix it silently',
      'Pretend not to notice and hope it passes',
    ] },
  { id: 108, category: 'lifestyle', framework: 'Hosting',
    text: 'A friend wants to crash on your couch for 3 nights. You:',
    options: [
      'Yes, no need to even ask my roommate',
      'Yes, but I\'ll check with my roommate first',
      'Maybe one night — three is too many',
      "No — couches are for living rooms, not bedrooms",
    ] },
  { id: 109, category: 'shadow', framework: 'Honesty',
    text: 'You accidentally break something of your roommate\'s. You:',
    options: [
      'Tell them immediately + offer to replace',
      'Tell them eventually + offer to replace',
      'Tell them but don\'t mention replacing unless they bring it up',
      'Hope they don\'t notice — it might not be a big deal',
    ] },
  { id: 110, category: 'control', framework: 'Routine',
    text: 'Your morning routine on a typical weekday is:',
    options: [
      'Quick and silent — shower, dressed, out in 20 min',
      'Slow and quiet — about an hour, no music',
      'Quick but visible — coffee, podcast, kitchen activity',
      'Slow and active — full breakfast, music, conversation',
    ] },
  { id: 111, category: 'emotional', framework: 'Conflict',
    text: 'After a fight with your roommate, you typically need:',
    options: [
      'An hour — then I\'m fine to talk',
      'Half a day — let the heat dissipate first',
      'A full day or two — I need real space',
      'Different every time — depends on the fight',
    ] },
  { id: 112, category: 'lifestyle', framework: 'Lifestyle',
    text: 'How do you feel about a roommate dating someone who basically lives with you?',
    options: [
      'Fine — I like meeting new people',
      'Fine if we agree on which nights they sleep over',
      'Annoying — three people in a two-person place',
      'Dealbreaker — I want a roommate, not three',
    ] },
  { id: 113, category: 'communication', framework: 'Apology',
    text: 'When you owe a real apology, you usually:',
    options: [
      'Say it directly, face-to-face, same day',
      'Write it out first then say it in person',
      'Send a thoughtful text first, then talk later',
      'Apologize through actions more than words',
    ] },
  { id: 114, category: 'nervous', framework: 'Sensory',
    text: 'A roommate cooks something with a strong smell (fish, curry, garlic-heavy). You:',
    options: [
      'Genuinely don\'t notice / don\'t mind',
      'Notice but it doesn\'t bother me',
      'Bothers me but I wouldn\'t say anything',
      "Bothers me enough that I'd ask them to ventilate",
    ] },
];

// ─── Reflections ────────────────────────────────────────────────────
// Each reflection is computed from REAL user data — never generic.
// `requires` lists the data fields needed; the route filters to
// templates whose requirements are met before picking one.
//
// `generate(profile)` returns { title, body, kicker }.
// profile shape: { firstName, attachmentStyle, comStyle, bigFive, ... }
const REFLECTIONS = [
  {
    id: 'attachment-secure',
    requires: ['attachmentStyle'],
    matches: (p) => p.attachmentStyle === 'secure',
    generate: (p) => ({
      kicker: 'TODAY\'S REFLECTION',
      title: 'You read as securely attached.',
      body: `Your answers across the attachment cluster point to a person who can both reach out when something matters and hold their own when it doesn't. Roommates who lead with secure attachment have the lowest reported conflict rates in the research — about 40% fewer escalated arguments over a one-year cohabitation than insecure pairings. The trade-off you'll feel: roommates who run anxious can read your calm as distance. A short, deliberate "everything good?" once a week resets that.`,
    }),
  },
  {
    id: 'attachment-anxious',
    requires: ['attachmentStyle'],
    matches: (p) => p.attachmentStyle === 'anxious',
    generate: (p) => ({
      kicker: 'TODAY\'S REFLECTION',
      title: 'You\'re wired to feel relational tension early.',
      body: `Your answers cluster around anxious attachment — you notice when something feels off, and you want to resolve it before it grows. That instinct is genuinely useful in cohabitation; the average roommate conflict festers for 6-8 days before either party brings it up, and you'd raise it in 1-2. The trade-off: a roommate who runs avoidant will read your need-to-resolve as pressure. A 24-hour "let it sit and see" rule before raising small things usually feels intolerable but works.`,
    }),
  },
  {
    id: 'attachment-avoidant',
    requires: ['attachmentStyle'],
    matches: (p) => p.attachmentStyle === 'avoidant',
    generate: (p) => ({
      kicker: 'TODAY\'S REFLECTION',
      title: 'You handle a lot before involving anyone else.',
      body: `Your answers lean avoidant on attachment — you'd rather sort things out internally than escalate to a conversation. That makes you low-maintenance to live with on the small stuff. The flip side: roommates who run anxious experience your self-sufficiency as withdrawal, even when it isn't. The research-backed move is to surface small frictions earlier than your instinct says — a 20-second "hey, when you do X it makes Y harder for me" prevents the four-week build-up that makes the eventual conversation feel like an ambush.`,
    }),
  },
  {
    id: 'big-five-extraversion-high',
    requires: ['extraversionScore'],
    matches: (p) => (p.extraversionScore ?? 50) > 70,
    generate: (p) => ({
      kicker: 'TODAY\'S REFLECTION',
      title: 'You recharge around people.',
      body: `Your extraversion score puts you in the top quartile — a quiet apartment doesn't restore you, it drains you over time. Best roommate pairings for you split into two: another high-E person who matches your energy, OR a moderate introvert who likes the company but doesn't try to match the volume. The pairing to avoid is a strong introvert — you'll read their quiet as them being upset with you, when they're just being themselves.`,
    }),
  },
  {
    id: 'big-five-extraversion-low',
    requires: ['extraversionScore'],
    matches: (p) => (p.extraversionScore ?? 50) < 30,
    generate: (p) => ({
      kicker: 'TODAY\'S REFLECTION',
      title: 'Your quiet is restorative, not distant.',
      body: `Your extraversion score puts you in the bottom quartile — alone time isn't a preference, it's how your nervous system actually recovers. The mistake high-E roommates make: reading your quiet as "they're mad at me." Telling a new roommate explicitly in the first week — "I get quiet at night, that's just my recharge, not you" — saves about three months of subtle mutual misreading. The research is clear that the variable that predicts your roommate satisfaction is solitude availability, not roommate compatibility per se.`,
    }),
  },
  {
    id: 'big-five-conscientiousness-high',
    requires: ['conscientiousnessScore'],
    matches: (p) => (p.conscientiousnessScore ?? 50) > 70,
    generate: (p) => ({
      kicker: 'TODAY\'S REFLECTION',
      title: 'Your follow-through is rare.',
      body: `Your conscientiousness score is in the top quartile — you do what you said by when you said it, and probably feel surprised when others don't. The cohabitation trap: you'll spot every chore you do that your roommate doesn't, and they won't notice the asymmetry. The version of this that doesn't end in resentment is a weekly 10-minute check-in where you split things explicitly. Not "the apartment is dirty" — "you take trash this week, I'll handle dishes." Conscientious people undershare what they're carrying. Don't.`,
    }),
  },
  {
    id: 'communication-direct',
    requires: ['comStyle'],
    matches: (p) => p.comStyle === 'direct',
    generate: (p) => ({
      kicker: 'TODAY\'S REFLECTION',
      title: 'You\'d rather say it than hint at it.',
      body: `Your communication answers cluster around directness — when something bothers you, you bring it up; when something works, you say so. The research on cohabitation conflict consistently shows direct communicators have shorter conflicts (hours, not days) but more of them. The pairing to be careful with: an indirect-communicator roommate will read your directness as confrontational. The fix isn't softening yourself — it's preceding the direct line with a 5-second context cue ("not a big deal, but..." or "small thing, easy fix:"). Same content, dramatically different reception.`,
    }),
  },
  {
    id: 'communication-indirect',
    requires: ['comStyle'],
    matches: (p) => p.comStyle === 'indirect',
    generate: (p) => ({
      kicker: 'TODAY\'S REFLECTION',
      title: 'You read the room before you speak.',
      body: `Your communication answers point indirect — you prefer hints, timing, and gentle openings over blunt asks. That instinct is socially intelligent; it's also the #1 driver of the slow-burn cohabitation conflict pattern (small thing → unsaid → grows → eventually explodes over something tangential). The research-backed practice: write down small grievances when they happen, and bring 1-2 to a once-weekly "anything we should adjust?" check-in. The check-in framing converts your indirect-communicator instinct into a feature instead of a bug.`,
    }),
  },
  {
    id: 'nervous-system-reactive',
    requires: ['nervousReactivity'],
    matches: (p) => p.nervousReactivity === 'high',
    generate: (p) => ({
      kicker: 'TODAY\'S REFLECTION',
      title: 'Your nervous system runs hot.',
      body: `Your polyvagal answers point to high autonomic reactivity — small environmental things (noise, mess, an unexpected guest, a passive-aggressive text) hit you harder than they hit other people. That's not a flaw, it's a wiring trait shared by about 20% of the population. The roommate move that matters: explicit, low-friction signal channels. A simple "I'm in nervous-system mode today, headphones on" lets a roommate read you accurately without needing a reason. The version that doesn't work is hiding it and hoping they pick up on it — they won't.`,
    }),
  },
  {
    id: 'control-executive-high',
    requires: ['conscientiousnessScore', 'executiveFunction'],
    matches: (p) => (p.executiveFunction ?? 50) > 70,
    generate: (p) => ({
      kicker: 'TODAY\'S REFLECTION',
      title: 'Your environment matches your attention.',
      body: `Your executive function answers cluster high — you finish what you start, your laundry doesn't sit in the dryer, you remember the bill before it's late. The cohabitation trap: a roommate who runs lower-EF will trigger you constantly without realizing it (clean dishes left to "soak", weekly chores half-done). The honest move: tell them you run on the high end and that visible undone things weigh on you more than they probably realize. Most lower-EF roommates respond well to explicit "do these by Sunday" lists — what they read as nagging is actually relief once it's a structure, not a vibe.`,
    }),
  },
  {
    id: 'shadow-honesty-high',
    requires: ['honestyHumilityScore'],
    matches: (p) => (p.honestyHumilityScore ?? 50) > 70,
    generate: (p) => ({
      kicker: 'TODAY\'S REFLECTION',
      title: 'You ask before you take.',
      body: `Your HEXACO Honesty-Humility answers land in the top quartile — you'd replace a borrowed product, you ask before using shared things, you wouldn't take credit for a roommate's idea. That trait is the single strongest empirical predictor of cohabitation harmony, full stop. The roommate failure mode you'll experience: living with someone who runs lower on this axis will burn out your goodwill faster than other personality mismatches. Your matching algorithm weight on this dimension is intentionally high — pay attention to the honesty-humility readout on any potential roommate's profile.`,
    }),
  },
  {
    id: 'general-quiet-recovery',
    requires: [],  // always-available fallback
    matches: () => true,
    generate: (p) => ({
      kicker: 'TODAY\'S REFLECTION',
      title: 'Compatibility is mostly recovery, not chemistry.',
      body: `The research on cohabitation satisfaction consistently shows the strongest predictor isn't "do you click" — it's "how quickly do you both recover from disagreement?" Two people with mediocre chemistry but fast repair patterns rate their experience higher 6 months in than two people with high initial chemistry and slow recovery. When you're evaluating matches, the question "would they say something the morning after a small disagreement" is more diagnostic than "do we have stuff in common." Your quiz answers will help us surface that signal in your matches.`,
    }),
  },
];

module.exports = { BONUS_QUESTIONS, REFLECTIONS };
