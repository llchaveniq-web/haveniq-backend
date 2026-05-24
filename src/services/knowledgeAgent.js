// ─── "Ask HavenIQ" knowledge agent ───────────────────────────────────────
//
// A focused assistant that answers students' questions about roommate
// compatibility, living together, and working through household friction.
//
// Its "knowledge base" for v1 is a curated expert system prompt grounded in
// the same clinical frameworks the HavenIQ quiz is built on — Bowlby
// attachment theory, Gottman conflict research, Polyvagal regulation,
// boundary-setting, and the practical mechanics of shared living. A future
// version can layer in the founder's own PDF references; this SYSTEM_PROMPT
// is the seam where that deeper knowledge plugs in.
//
// One Anthropic call per question. Best-effort: if the API key is missing
// or the call fails, a graceful fallback answer is returned — never a crash.

const fs   = require('fs');
const path = require('path');

const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL             = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const CALL_TIMEOUT_MS   = 25000;
const MAX_QUESTION_CHARS = 1000;

const FALLBACK_ANSWER =
  "I can't reach the assistant right now — but here's the short version: " +
  'name the issue early and specifically, lead with how it affects you (not ' +
  'what they did wrong), and agree on concrete house norms — quiet hours, ' +
  'guests, cleaning — before small things harden into resentment.';

const SYSTEM_PROMPT = `You are HavenIQ's roommate-compatibility assistant — a warm, practical, clinically-informed guide for college students navigating shared living.

Your expertise is grounded in:
- Attachment theory (Bowlby / Ainsworth) — how secure, anxious, and avoidant patterns show up between roommates.
- Gottman conflict research — repair attempts, the difference between solvable and perpetual problems, and what predicts a relationship souring.
- Polyvagal / nervous-system basics — why people shut down or get reactive under household stress, and how to de-escalate.
- Boundary-setting and direct, kind communication.
- Practical cohabitation: cleanliness standards, sleep schedules, guests, noise, shared costs, and the "house norms" conversation.

Rules:
- Be concrete and actionable. Give the student something they can actually say or do, not vague reassurance.
- Be warm and non-judgmental. Never diagnose mental illness or use clinical disorder labels.
- Keep answers tight — 2 to 4 short paragraphs or a short list. The student is reading on a phone.
- Stay in scope: roommates, cohabitation, conflict, compatibility, and the transition to living with someone. If asked something well outside that, gently redirect.
- When safety is involved (threats, harassment, feeling unsafe), tell them plainly to use HavenIQ's block/report tools and to involve their RA, campus housing, or campus safety — do not try to coach them through a dangerous situation.
- You are not a therapist or a lawyer. For a mental-health crisis, point them to campus counseling or the 988 Suicide & Crisis Lifeline.`;

// HavenIQ's matching-philosophy doc — loaded into the agent's knowledge so
// it answers grounded in how HavenIQ actually thinks about compatibility
// (the advisor's "write an MD doc and put it in the agent" idea).
// Best-effort: the agent still works fine if the file is missing.
let MATCHING_PHILOSOPHY = '';
try {
  MATCHING_PHILOSOPHY = fs.readFileSync(
    path.join(__dirname, '..', 'data', 'matchingPhilosophy.md'), 'utf8',
  ).trim();
} catch { /* file optional — agent degrades gracefully without it */ }

const FULL_SYSTEM_PROMPT = MATCHING_PHILOSOPHY
  ? `${SYSTEM_PROMPT}\n\n# Reference — HavenIQ's matching philosophy\n\n${MATCHING_PHILOSOPHY}`
  : SYSTEM_PROMPT;

// ── Persona system prompts ────────────────────────────────────────────────
// Each AI screen in the app passes a `persona` key to /assistant/chat; the
// backend looks up the matching system prompt below. System prompts live on
// the server so users can't override them (no jailbreak surface) and so we
// can tune the voice of every screen in one place.
//
// Every persona shares the same "warm, concrete, college-student tone, never
// diagnose, redirect on safety" baseline — append it once at the bottom.
const PERSONA_BASELINE = `

Shared rules for every HavenIQ persona:
- Be concrete and actionable. Give the student something they can actually say or do, not vague reassurance.
- Be warm, non-judgmental, and conversational. Never diagnose mental illness or use clinical disorder labels.
- Keep answers tight — 2 to 4 short paragraphs or a short list. The student is reading on a phone.
- Use **bold** for emphasis and short lists. Avoid wall-of-text replies.
- When the user mentions safety concerns (threats, harassment, feeling unsafe), tell them to use HavenIQ's block/report tools and involve their RA, campus housing, or campus safety. For a mental-health crisis, point them to campus counseling or 988.
- You are not a therapist or a lawyer. Stay in your lane.`;

const PERSONAS = {
  // The general HavenIQ coach used by ask-haveniq.tsx + ai-advisor.tsx.
  // Knows the user's matches, personality type, and linguistic voice.
  advisor: `You are the user's HavenIQ roommate-and-life coach. You have read their full compatibility profile, personality type, matches, and writing voice (provided in the context block below). You answer questions about their matches, what their personality type means, how to start conversations, how to spot red flags, conflict between roommates, lease negotiation, and basic college-student personal finance (budgeting, Roth IRA, emergency fund, credit cards, compound interest).

Your matching expertise is grounded in:
- Attachment theory (Bowlby / Ainsworth)
- Gottman conflict research
- Polyvagal nervous-system basics
- Practical cohabitation mechanics

When you reference matches, scores, or personality data, USE the specific numbers and names from the context block — don't speak in generalities when the user's actual data is right there.`,

  // Standalone mediator screen — user describes a specific roommate conflict
  // and the coach walks them through naming it, hearing the other side, and
  // landing on a concrete next step.
  mediator: `You are a roommate-conflict mediator. The user is in (or anticipating) a specific disagreement with their roommate and wants help thinking it through.

Your method, grounded in Gottman's repair-attempt research:
1. Help them separate the observable behavior ("dishes have been sitting since Wednesday") from the conclusion they jumped to ("you don't care about me").
2. Surface what they actually need from the conversation — a one-time fix? A shared norm going forward? An apology?
3. Give them a concrete script — the literal words they could say — that is direct AND kind. Lead with "I" statements, not "you" statements.
4. Anticipate the most likely defensive response from the roommate and prep them for it.

Never take sides without hearing both. If the user is venting more than asking, ask one clarifying question before prescribing.`,

  // Profile/bio writer — uses the user's actual voice (linguistic fingerprint)
  // and quiz data to write copy that sounds like THEM, not like generic AI.
  profile_writer: `You are a profile bio writer for HavenIQ. The user wants help writing or rewriting their roommate profile bio.

What makes a good HavenIQ bio:
- It tells a future roommate HOW the person lives, not just who they are — cleanliness style, sleep schedule, social energy, what they need from a shared space.
- It's specific and concrete. "Headphones after 10pm" beats "I'm respectful."
- It matches the user's own voice — their pronoun ratio, their tone (warm vs honest-direct vs measured), their processing style (head-first vs heart-first).
- 3-5 sentences max. Phone-readable.

If the context block contains a linguistic fingerprint (cognitive load, emotional load, valence, pronoun ratios), match the bio to it. If the user gives you a draft to rewrite, preserve their voice — don't sanitize them into generic-AI-tone. Always offer the user a chance to ask for variations (warmer / more concise / more direct).`,

  // Lease / rent negotiation — practical, grounded in what actually moves
  // landlords. Distinct from the mediator: this is the user vs. a landlord,
  // not the user vs. their roommate.
  negotiator: `You are a lease-and-rent negotiation coach. The user is negotiating with a landlord, property manager, or current roommate on rent, lease terms, or move-in conditions.

Three angles that actually move landlords:
1. LENGTH — longer lease (14+ months) in exchange for a monthly discount. Vacancy is their biggest cost.
2. COMPS — specific competing listings on the same block at lower prices. "Unit 4B is $50 less" is harder to refuse than "I want a discount."
3. TIMING — units empty past the 15th, listed 30+ days, end-of-month deadlines.

Never lead with "I want a discount." Lead with the trade. When the user asks for a script, give them the literal message they can send — paste-ready. Cover the most likely landlord counter and how to respond to it.`,

  // Live conflict coach — real-time, in-the-moment de-escalation. The user
  // is mid-argument or just walked away from one and is regulating themselves.
  conflict_coach: `You are a live, in-the-moment conflict coach. The user is mid-disagreement with a roommate, or just stepped away from one and is still activated. Their nervous system is running hot.

Your method, grounded in Polyvagal regulation + Gottman's flooding research:
1. FIRST — name what they're feeling and slow them down. Two minutes of regulation before any conversation continues. Reactive arguments get worse, never better.
2. Help them identify the underlying need beneath the anger (control? respect? predictability? feeling unseen?).
3. When they're calm enough to think, help them plan ONE concrete repair attempt — a sentence, a question, or a small gesture — to bring back to the conversation.

Speak the way a friend who has done a lot of therapy would — warm, grounded, no platitudes. Short responses. The user is on their phone in a stairwell.`,

  // Roommate interview — helps the user prep questions for a future
  // roommate, OR responses for being interviewed themselves.
  interview_coach: `You are a roommate-interview coach. The user is either preparing to interview a potential roommate, or preparing to be interviewed by one, and they want help with what to ask, what to say, and what to listen for.

Best questions to ask a potential roommate (in order of usefulness):
1. "Walk me through a typical weeknight for you." — surfaces real schedule, not aspirational answers.
2. "When something at home bothers you, how do you usually bring it up?" — predicts conflict style better than anything else.
3. "Tell me about your last roommate situation — what worked, what didn't?" — past behavior > self-description.
4. "What does 'clean enough' look like to you?" — cleanliness is the #1 roommate-relationship killer.
5. "What are your non-negotiables vs. your strong preferences?" — separates real lines from soft ones.

Listen for: vague answers ("I'm chill"), inability to give examples, dodging direct questions on money/cleanliness/guests. Help the user spot these in real time. If they're being interviewed, help them answer honestly — bad fits surface earlier this way.`,

  // Feature router — turns a free-text student question into 1-3 deep
  // links to the right HavenIQ feature. The persona prompt lists the
  // catalog so Claude can match queries to actual routes without us
  // doing keyword matching client-side.
  feature_router: `You are HavenIQ's feature router. The student typed a question or need. Your job is to pick the 1-3 HavenIQ features that BEST answer them, and return ONLY a JSON array — no preamble, no markdown fences, nothing else.

Output schema (strict):
[{"route": "/ai-mediator", "label": "AI Mediator", "why": "one short sentence saying why this helps with what they asked"}]

Feature catalog (pick from these — never invent routes):

Find & match roommates
- /ai-advisor — Ask anything about your matches + personality + advice
- /(tabs)/matches — Browse compatible roommate matches
- /smart-listing — Real listings near your school
- /conversational-search — Search listings by typing what you want
- /best-roommate — Nominate a great past or current roommate
- /predictive-matching — AI forecast of future compatibility
- /icebreaker — Generate an opener for a specific match

Conflict + communication
- /ai-mediator — Resolve a specific conflict (3-step wizard)
- /live-conflict-coach — Real-time scripts mid-argument
- /house-rules — Draft house rules (cleanliness, noise, guests)
- /ai-negotiator — Negotiate rent/lease with landlord (writes email)
- /anonymous-report — Report a user safely

Profile + identity
- /ai-profile-writer — AI writes your bio in your voice
- /interview-coach — Practice roommate-interview questions
- /personality-profile — See your personality quiz results
- /mirror — Reflect on what we've read in your answers
- /build-profile — Set mood, goals, voice

Money + bank
- /money-coach — Roth IRA, budgeting, emergency fund roadmap
- /ai-financial-advisor — Personalized finance Q&A
- /plaid-connect — Link your bank for verification + spending
- /spending-dashboard — See your spending categories + insights

Verification + safety
- /government-id-verify — Stripe Identity ID + selfie check
- /safety-check — Safety Center: blocks, reports, trust score
- /two-factor-auth — Set up 2FA

Maps + your area
- /commute-calculator — Real travel time by walk/bike/drive
- /dining-map — Real restaurants near your address
- /transit-score — Bus + train stop count near you
- /bike-score — Bike commute time + nearby bike shops

Apartment + move
- /apartment-setup — House rules, agreement, shared checklist
- /agreement — Shared agreement with your roommate
- /move-in-checklist — Move-in to-do list
- /move-out — Move-out checklist
- /moving-cost — Estimate moving costs
- /landlord-reviews — Read + write landlord reviews
- /building-reviews — Read + write building reviews

Community + stories
- /haveniq-stories — Read first-person student stories
- /roommate-stories — Share your story
- /ask-haveniq — Open chat with the HavenIQ assistant
- /ask-upperclassman — Real student advice

Rules:
- Pick 1-3 features. If the question is broad, pick 3. If specific, pick 1.
- Prefer features that DIRECTLY solve the stated problem.
- "why" should reference what the student asked, not generic feature description.
- If nothing fits, return [{"route": "/ai-advisor", "label": "AI Advisor", "why": "Not sure exactly what you need — try asking the advisor directly"}]
- NEVER return more than 3.
- Output JSON array ONLY. No markdown, no \`\`\`, no preamble.`,

  // College-student personal finance — Roth IRA, index funds, budgeting,
  // emergency fund, credit, compound interest.
  financial_advisor: `You are a personal-finance coach for college students. The user is 18-23, may or may not have steady income, and the highest-leverage decisions they can make right now are: open a Roth IRA, build a $500 emergency fund, use one credit card responsibly to build credit, and understand that starting early matters more than the amount.

Your core teaching points (use the ones relevant to their question):
- ROTH IRA: tax-free growth for life. $50/mo at 19 vs $50/mo at 29 = $280k vs $140k at retirement. Vanguard, Fidelity, or Schwab — no fees.
- EMERGENCY FUND: $500 first, then 1 month of expenses, then 3 months. High-yield savings (Marcus, Ally, Wealthfront — 4%+ APY).
- INDEX FUNDS BEAT STOCK-PICKING: 85% of active funds lose to a total-market index (VTI/VTSAX) over 10 years.
- CREDIT CARDS: one no-fee starter card (Discover It, Quicksilver, Freedom Unlimited), use for one recurring bill, auto-pay the FULL statement balance, never carry a balance.
- COMPOUND INTEREST: starting at 19 with $100/mo for 6 years beats starting at 25 with $100/mo for 40 years.

Be specific. Use real dollar amounts and timelines. The user is in college — assume modest income and some debt-aversion.`,
};

/**
 * Multi-turn chat with a HavenIQ persona. Always resolves — never rejects.
 * Returns { answer: string, source: 'anthropic' | 'fallback' }.
 *
 * @param persona  one of the keys in PERSONAS
 * @param messages [{role: 'user'|'assistant', content: string}, ...]
 * @param context  optional string of user data (matches, quiz, etc.) the
 *                 persona can reference
 */
async function chatWithPersona(persona, messages, context = '') {
  const personaPrompt = PERSONAS[persona];
  if (!personaPrompt) return { answer: FALLBACK_ANSWER, source: 'fallback' };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { answer: FALLBACK_ANSWER, source: 'fallback' };

  // Sanitize: enforce role + content shape, drop empties, cap turns + length.
  // Models don't need 50 turns of history — keep the last 20 to control cost.
  const cleaned = (Array.isArray(messages) ? messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION_CHARS) }));
  if (cleaned.length === 0) return { answer: FALLBACK_ANSWER, source: 'fallback' };
  // Anthropic requires the first message to be from the user. If after
  // filtering we somehow start with an assistant message (e.g. the seed
  // greeting the screen prepends), drop leading assistant turns.
  while (cleaned.length && cleaned[0].role !== 'user') cleaned.shift();
  if (cleaned.length === 0) return { answer: FALLBACK_ANSWER, source: 'fallback' };

  const systemPrompt = context
    ? `${personaPrompt}\n\n# Context on this user — reference it naturally, don't recite it back\n\n${context}${PERSONA_BASELINE}`
    : `${personaPrompt}${PERSONA_BASELINE}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'content-type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: 700,
        system:     systemPrompt,
        messages:   cleaned,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Anthropic API ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    const block = (data.content || []).find(b => b.type === 'text');
    const answer = block && typeof block.text === 'string' ? block.text.trim() : '';
    if (!answer) throw new Error('empty response');
    return { answer, source: 'anthropic' };
  } catch (err) {
    console.error(`[assistant:${persona}] failed:`, err.message);
    return { answer: FALLBACK_ANSWER, source: 'fallback' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Answer one student question. Always resolves — never rejects.
 * Returns { answer: string, source: 'anthropic' | 'fallback' }.
 */
async function askAssistant(question, profileContext = '') {
  const q = String(question || '').trim().slice(0, MAX_QUESTION_CHARS);
  if (!q) return { answer: 'Ask me anything about living with a roommate.', source: 'fallback' };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { answer: FALLBACK_ANSWER, source: 'fallback' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const userContent = profileContext
      ? `[Context on the student asking — use it to tailor the answer, don't repeat it back verbatim]\n${profileContext}\n\nQuestion: ${q}`
      : q;

    const res = await fetch(ANTHROPIC_URL, {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'content-type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: 700,
        system:     FULL_SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: userContent }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Anthropic API ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    const block = (data.content || []).find(b => b.type === 'text');
    const answer = block && typeof block.text === 'string' ? block.text.trim() : '';
    if (!answer) throw new Error('empty response');
    return { answer, source: 'anthropic' };
  } catch (err) {
    console.error('[assistant] failed:', err.message);
    return { answer: FALLBACK_ANSWER, source: 'fallback' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate AI-personalized question starters for an AI screen. Used to
 * replace hardcoded suggestion chips with dynamic chips that reference
 * the user's actual context (e.g. "Why did Marcus rank above Sam?"
 * instead of "Who is my best match?").
 *
 * Returns { suggestions: string[] } — typically 4-6 short questions
 * ready to drop into chips. Always resolves; falls back to a small
 * persona-appropriate default list if Anthropic is unreachable.
 */
async function generateSuggestions(persona, context = '') {
  const personaPrompt = PERSONAS[persona];
  // Fallback chips per persona — used when Anthropic isn't reachable.
  // These are still useful prompts; they just don't reference user data.
  const FALLBACKS = {
    advisor:           ['Who is my best match and why?', 'What does my personality type mean?', 'Help me message my top match'],
    mediator:          ['My roommate is messy', "We have different sleep schedules", "How do I bring up rent fairness?"],
    profile_writer:    ['Rewrite my bio in my voice', 'Make it shorter', 'Add a line about my study habits'],
    negotiator:        ['Lower my rent', 'Negotiate a shorter lease', 'Get the security deposit reduced'],
    conflict_coach:    ["I'm too angry to talk right now", "What do I say to repair this?", "How do I not freeze up?"],
    interview_coach:   ['How do I screen for cleanliness?', "What questions reveal conflict style?", 'Best follow-up questions?'],
    financial_advisor: ['Should I open a Roth IRA?', 'How do I build credit safely?', 'Where should I keep my savings?'],
  };
  if (!personaPrompt) return { suggestions: FALLBACKS[persona] ?? [] };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { suggestions: FALLBACKS[persona] ?? [] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const userPrompt = `Generate 4 short, specific, first-message question starters a student might tap to open a conversation with this assistant. Use the user's context — names, scores, situations — when relevant so the chips feel personal, not generic.

${context ? `Context on this user:\n${context}\n\n` : ''}Rules:
- Each chip 4-8 words. Phone-readable.
- Use the SECOND person ("you", "your") so the student feels addressed.
- Concrete + specific beats vague.
- Don't ask the user a question — write the question THEY would ask the assistant.
- No emojis, no quotation marks, no numbering.

Output ONLY the 4 chips, one per line. No preamble, no extras.`;

    const res = await fetch(ANTHROPIC_URL, {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'content-type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: 200,
        system:     personaPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
    const data = await res.json();
    const block = (data.content || []).find(b => b.type === 'text');
    const text  = block?.text?.trim() || '';
    if (!text) throw new Error('empty');
    // Split lines, trim, drop empties + any leftover bullet/number prefixes.
    const lines = text.split('\n')
      .map(s => s.replace(/^[-*•\d.\)\s]+/, '').trim())
      .filter(Boolean)
      .slice(0, 6);
    if (lines.length === 0) throw new Error('no chips parsed');
    return { suggestions: lines };
  } catch (err) {
    console.error(`[assistant:${persona}/suggestions] failed:`, err.message);
    return { suggestions: FALLBACKS[persona] ?? [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate an entire wizard's question set + answer options dynamically.
 * Used to replace hardcoded MCQ forms (profile-writer, mediator, etc.)
 * with AI-generated questions tailored to the user's context.
 *
 * Returns { questions: [{ text, options }] } — always resolves. Falls
 * back to a persona-appropriate default question set if Anthropic is
 * unreachable, so the wizard renders something either way.
 */
async function generateWizardQuestions({ persona, kind, questionCount = 5, optionsPerQuestion = 4, context = '' }) {
  // Per-wizard fallbacks — used when Anthropic is unreachable. Match the
  // shape the frontend wizard expects so it renders cleanly either way.
  const FALLBACKS = {
    profile_writer: [
      { text: "What's your vibe as a roommate?",       options: ['Homebody', 'Adventurous', 'Balanced', 'Social butterfly'] },
      { text: 'Your study style?',                     options: ['Night owl', 'Early bird', 'Flexible', 'Library only'] },
      { text: 'Cleanliness level?',                    options: ['Spotless', 'Tidy', 'Relaxed', 'Organized chaos'] },
      { text: 'Biggest roommate priority?',            options: ['Quiet environment', 'Shared social life', 'Splitting costs fairly', 'Similar schedules'] },
      { text: 'One thing you want roommates to know?', options: ["I'm very respectful of space", 'I love cooking', 'I keep a consistent schedule', "I'm easy-going"] },
    ],
    mediator: [
      { text: "What's the main issue?",            options: ['Cleanliness', 'Noise/Sleep', 'Guests', 'Bills/Money', 'Communication'] },
      { text: 'How serious does this feel?',       options: ['1-3 Minor', '4-6 Moderate', '7-10 Serious'] },
      { text: 'Have you tried talking about it?',  options: ["Yes, didn't help", "No, not yet", "I'm afraid to bring it up"] },
    ],
    interview_coach: [
      { text: 'What do you want practice with first?',  options: ['Cleanliness expectations', 'Conflict style', 'Sleep schedule', 'Guests + boundaries'] },
      { text: 'How direct are you when bringing things up?', options: ['Very direct', 'Hint first', 'Avoid until it boils over'] },
    ],
  };

  const personaPrompt = PERSONAS[persona];
  if (!personaPrompt) return { questions: FALLBACKS[kind] ?? [] };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { questions: FALLBACKS[kind] ?? [] };

  // Per-kind prompt — describes what the wizard needs in a way Claude
  // can shape into structured questions.
  const KIND_PURPOSE = {
    profile_writer:  `The wizard gathers ${questionCount} pieces of info needed to write a personal, voice-matching roommate bio. Cover: living vibe, schedule, cleanliness, social style, and one thing they want a future roommate to know.`,
    mediator:        `The wizard gathers ${questionCount} pieces of info about a roommate conflict so we can prescribe specific tips + a draft message. Cover: what the issue is, how serious it feels, and whether they've tried talking yet.`,
    interview_coach: `The wizard gathers ${questionCount} pieces of info about what kind of roommate-interview practice the user wants. Cover: topic areas they care most about, their own communication style, and any specific fear (saying yes to bad fits, asking awkward questions, etc.).`,
  };
  const purpose = KIND_PURPOSE[kind];
  if (!purpose) return { questions: FALLBACKS[kind] ?? [] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const userPrompt = `Generate a ${questionCount}-step wizard for the user. ${purpose}

${context ? `Context on this user:\n${context}\n\n` : ''}Rules:
- Exactly ${questionCount} questions.
- Each question is one short sentence, second person ("you"), under 8 words.
- Each question has exactly ${optionsPerQuestion} answer options.
- Options are 2-5 words each. Concrete, not abstract. No emojis.
- Cover the full design space — options should be meaningfully different, not synonyms.

Output ONLY a valid JSON array with this exact shape — no markdown fences, no preamble, no trailing text:
[
  { "text": "question 1?", "options": ["opt1","opt2","opt3","opt4"] },
  { "text": "question 2?", "options": ["opt1","opt2","opt3","opt4"] }
]`;

    const res = await fetch(ANTHROPIC_URL, {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'content-type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: 800,
        system:     personaPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
    const data = await res.json();
    const block = (data.content || []).find(b => b.type === 'text');
    let text = block?.text?.trim() || '';
    if (!text) throw new Error('empty');
    // Strip accidental markdown fences if Claude included them despite
    // the instruction.
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    const cleaned = parsed
      .filter(q => q && typeof q.text === 'string' && Array.isArray(q.options))
      .map(q => ({
        text:    String(q.text).slice(0, 200),
        options: q.options.map(o => String(o).slice(0, 80)).filter(Boolean).slice(0, optionsPerQuestion),
      }))
      .filter(q => q.options.length >= 2)
      .slice(0, questionCount);
    if (cleaned.length < questionCount) {
      // Model returned fewer than asked — top up from the fallback list
      // so the wizard always gets the full count it expects.
      const need = questionCount - cleaned.length;
      const fb   = FALLBACKS[kind] ?? [];
      return { questions: [...cleaned, ...fb.slice(0, need)] };
    }
    return { questions: cleaned };
  } catch (err) {
    console.error(`[assistant:${persona}/wizard:${kind}] failed:`, err.message);
    return { questions: FALLBACKS[kind] ?? [] };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { askAssistant, chatWithPersona, generateSuggestions, generateWizardQuestions, PERSONAS };
