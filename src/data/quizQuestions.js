// ─── Quiz question text (backend mirror) ─────────────────────────────────
//
// The backend stores quiz answers as bare numbers ({ "14": 1, "50": 2, ... }
// — question id -> chosen option index). The scoring engine needs only those
// numbers, but the AI features (About You personality reveal, matched-moment)
// need the actual QUESTION TEXT + OPTION TEXT to hand the model something
// meaningful. This file is that lookup table.
//
// It mirrors the 17 questions the app actually asks — frontend
// constants/quiz.ts SCORED_IDS: 14, 48–57, 60, 62, 63, 65–67 (14 lifestyle /
// behavioral + 3 stress-response). Older removed questions (attachment, Big
// Five, HEXACO, etc. from the pre-2026 60-question set) were dropped: no
// student can answer them, so every consumer's id->text lookup already
// skipped them. IDs stay non-contiguous — preserved from the original set.
// If the frontend quiz text changes, mirror the change here.

module.exports = [
  {
    "id": 14,
    "category": "communication",
    "text": "Which is MORE true of you?",
    "options": [
      "I sometimes roll my eyes, sigh, or mock when frustrated with a roommate",
      "Even frustrated, I keep it civil and say things straight"
    ]
  },
  {
    "id": 48,
    "category": "lifestyle",
    "text": "How often do you have people over?",
    "options": [
      "Rarely or never",
      "Once or twice a month",
      "Most weekends",
      "Multiple times a week"
    ]
  },
  {
    "id": 49,
    "category": "lifestyle",
    "text": "What's your typical weekday bedtime?",
    "options": [
      "Before 10 PM",
      "10 PM – midnight",
      "Midnight – 2 AM",
      "After 2 AM — I'm a night owl"
    ]
  },
  {
    "id": 50,
    "category": "lifestyle",
    "text": "How clean do you keep shared spaces?",
    "options": [
      "Spotless — I clean constantly",
      "Clean most of the time",
      "I clean when it gets noticeable",
      "Honestly not a priority for me"
    ]
  },
  {
    "id": 51,
    "category": "lifestyle",
    "text": "Do you smoke, vape, or use cannabis at home?",
    "options": [
      "Never",
      "Cannabis occasionally",
      "Vape or smoke occasionally",
      "Regularly — it's part of my routine"
    ]
  },
  {
    "id": 52,
    "category": "lifestyle",
    "text": "How do you feel about a roommate's partner staying over often?",
    "options": [
      "Totally fine",
      "Occasionally, sure",
      "Prefer it's rare, with a heads-up",
      "I'd want it kept to a minimum"
    ]
  },
  {
    "id": 53,
    "category": "nervous system",
    "text": "When you're studying or working at home, you need…",
    "options": [
      "Near silence to focus",
      "Low background noise is fine",
      "Normal activity around me is fine",
      "I focus better with energy around"
    ]
  },
  {
    "id": 54,
    "category": "lifestyle",
    "text": "Are you comfortable with a roommate who drinks alcohol at home?",
    "options": [
      "Totally fine",
      "Fine occasionally",
      "Prefer they don't",
      "Not comfortable with it"
    ]
  },
  {
    "id": 55,
    "category": "lifestyle",
    "text": "In the kitchen, your approach to food is…",
    "options": [
      "Totally shared. Help yourself",
      "Sharing basics is fine",
      "Mostly separate",
      "Strictly separate. Label and ask"
    ]
  },
  {
    "id": 56,
    "category": "lifestyle / money",
    "text": "If a roommate constantly spent on things you'd consider wasteful, you'd feel...",
    "options": [
      "Honestly bothered — our shared rent is at stake",
      "Quietly judgmental but I wouldn't say anything",
      "Indifferent — their money, their choice",
      "Curious — I'd probably learn from them"
    ]
  },
  {
    "id": 57,
    "category": "executive function",
    "text": "You started a load of laundry 2 hours ago. Most likely scenario:",
    "options": [
      "Already folded and put away",
      "I'll move it to the dryer when I notice",
      "Still in the washer the next morning",
      "This happens to me weekly — I forget regularly"
    ]
  },
  {
    "id": 60,
    "category": "communication",
    "text": "After someone you live with apologizes for something, you typically...",
    "options": [
      "Accept it fully and genuinely move on",
      "Accept it but stay guarded for a few days",
      "Need to talk through it more before I can let go",
      "Say I'm fine but the resentment lingers honestly"
    ]
  },
  {
    "id": 62,
    "category": "communication / boundaries",
    "text": "A roommate asks for a favor you'd rather not do. You usually…",
    "options": [
      "Say yes anyway — I don't want to disappoint them",
      "Half-yes — do it, but reluctantly",
      "Politely decline and explain why",
      "Straightforward no — they can ask someone else"
    ]
  },
  {
    "id": 63,
    "category": "communication / repair initiation",
    "text": "After a fight with someone you live with, who usually makes the first move to fix it?",
    "options": [
      "Me, almost always",
      "Me — but only after some space",
      "Whoever cools down first",
      "Usually them — being the first is hard for me"
    ]
  },
  {
    "id": 65,
    "category": "stress",
    "text": "When you're stressed or overwhelmed at home, you tend to…",
    "options": [
      "I go quiet and need space",
      "I get short or irritable",
      "I want to talk it out right away",
      "I shut down and keep it in",
      "I clean or organize to cope"
    ]
  },
  {
    "id": 66,
    "category": "stress",
    "text": "After a rough day, what do you need at home?",
    "options": [
      "Total quiet, on my own",
      "Someone to vent to",
      "Low-key company, no pressure",
      "Space first, then talk"
    ]
  },
  {
    "id": 67,
    "category": "stress",
    "text": "In a disagreement with a roommate, you're more likely to…",
    "options": [
      "Push to resolve it now, even if it's tense",
      "Need to step away and cool off first",
      "Go along to keep the peace",
      "Get quiet and let it simmer"
    ]
  }
];
