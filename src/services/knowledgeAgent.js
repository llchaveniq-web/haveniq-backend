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

module.exports = { askAssistant };
