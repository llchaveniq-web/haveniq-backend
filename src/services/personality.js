// ─── Personality derivation ──────────────────────────────────────────────
//
// Turns a student's 22 quiz answers into a structured personality profile:
//   • Big Five / OCEAN scores (0-100 each) — the validated trait model
//   • an archetype (one of the 6 HavenIQ roommate archetypes)
//   • a short narrative + strengths + growth areas + roommate-fit note
//
// This runs ONCE per student, at quiz submission (see routes/quiz.js). It is
// NOT in the per-match path — matching stays a fast, free, weighted algorithm.
// One Anthropic call per signup keeps the cost to a fraction of a cent.
//
// The Anthropic call uses tool-use ("structured output") so the model is
// forced to return a schema-valid object — no brittle JSON-string parsing.
//
// Everything here is best-effort. If ANTHROPIC_API_KEY is missing, or the
// API call fails/times out, derivePersonality() returns a deterministic
// fallback profile computed straight from the answers. The caller always
// gets a usable profile and the quiz flow never breaks.

const QUESTIONS = require('../data/quizQuestions');
const analytics = require('./analytics');

const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// Override with the ANTHROPIC_MODEL env var. Sonnet gives the best profile
// quality; one call per student means cost is negligible. Switch to a Haiku
// model via the env var if you want to trim cost further.
const MODEL       = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const CALL_TIMEOUT_MS = 25000;

const ARCHETYPES = [
  'harmonizer',
  'structured_nester',
  'calm_anchor',
  'independent',
  'social_builder',
  'adaptive_partner',
];

const OCEAN_KEYS = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'];

// ─── Answer normalization ────────────────────────────────────────────────
// quiz_answers.answers is stored in the frontend wire shape, one of:
//   { type: 'option', index: N }  ·  { type: 'scale', value: N }  ·  bare N
// Flatten to { questionId: optionIndex }.
function flatten(answers) {
  const flat = {};
  for (const [k, v] of Object.entries(answers || {})) {
    if (typeof v === 'number') { flat[k] = v; continue; }
    if (v && typeof v === 'object') {
      if (typeof v.index === 'number')      flat[k] = v.index;
      else if (typeof v.value === 'number') flat[k] = v.value;
    }
  }
  return flat;
}

// ─── Prompt construction ─────────────────────────────────────────────────
function buildTranscript(flat) {
  const lines = [];
  for (const q of QUESTIONS) {
    const idx = flat[q.id];
    if (idx === undefined || idx === null) continue;
    const choice = q.options[idx];
    if (choice === undefined) continue;
    lines.push(`[${q.category}] ${q.text}\n  → "${choice}"`);
  }
  return lines.join('\n\n');
}

// Format the optional spoken voice-interview answers into a transcript
// block. Each entry is { question, transcript }. Returns '' when there
// are no usable answers.
function buildVoiceSection(voice) {
  if (!Array.isArray(voice) || voice.length === 0) return '';
  return voice
    .map((v) => {
      const q = String(v && v.question ? v.question : 'Open question').trim();
      const a = String(v && v.transcript ? v.transcript : '').trim();
      const emo = Array.isArray(v && v.emotions) && v.emotions.length
        ? `\n  [measured vocal tone: ${v.emotions.join(', ')}]`
        : '';
      return `Q: ${q}\nA (spoken): "${a}"${emo}`;
    })
    .join('\n\n');
}

// Format an optional free-text writing sample (essay, paper excerpt,
// personal statement) the student volunteered. Capped so one long upload
// can't blow out the prompt. Returns '' when there's nothing usable.
function buildWritingSection(writing) {
  const w = typeof writing === 'string' ? writing.trim() : '';
  return w ? w.slice(0, 6000) : '';
}

const SYSTEM_PROMPT = `You are a personality-assessment specialist working for HavenIQ, a college roommate-matching app. Students answer a 22-question quiz grounded in clinical frameworks (Bowlby attachment, Gottman, Polyvagal, ACEs, Jungian Shadow, HEXACO, Klontz money scripts, executive function, sensory processing).

Given one student's answers, derive a Big Five (OCEAN) personality profile and a roommate archetype.

Rules:
- Score each OCEAN trait 0-100, anchored to the actual answers. Do not default everything to ~50; let the answers move the scores.
- Be honest and clinical, not flattering or horoscopic. Name real tendencies, including less-flattering ones, but stay warm and non-judgmental.
- Frame everything around cohabitation / being a roommate. Do NOT diagnose mental illness or use clinical disorder language.
- Some students also record a short spoken voice interview — open-ended answers about home, past conflict, and roommate preferences, in their own words. When a voice interview is included, treat it as high-value signal: it reveals nuance, tone, and specifics the multiple-choice quiz cannot. Some answers carry a "[measured vocal tone: ...]" tag — an objective read of the emotion in HOW they spoke; weigh that alongside what they said. Let the voice interview meaningfully shape the scores and narrative.
- Some students also volunteer a personal writing sample (an essay, paper, or personal statement). When present, read it for how they actually think and express themselves — their natural written voice is strong signal. Let it shape the profile too.
- "summary" is 2-3 sentences. "strengths" and "growth_areas" are short concrete phrases. "roommate_fit" is 1-2 sentences on the kind of roommate this person lives well with.

Pick exactly one archetype:
- harmonizer: empathetic, peace-keeping, emotionally perceptive, collaborative.
- structured_nester: highly organized, routine-driven, reliable, high cleanliness standards.
- calm_anchor: emotionally regulated, non-reactive under pressure, steady, de-escalating.
- independent: self-sufficient, values personal space, low-maintenance, introspective.
- social_builder: energized by people, warm, welcoming, community-oriented, expressive.
- adaptive_partner: highly self-aware, emotionally flexible, honest about needs, growth-oriented.

Also produce two secondary, illustrative labels. These are popular but NOT
scientifically validated — they are display-only and never drive matching:
- "mbti": the closest Myers-Briggs 4-letter type (e.g. INFJ, ESTP).
- "disc": the dominant DISC style — one or two letters from D, I, S, C.

Call the record_personality_profile tool with your result.`;

const TOOL = {
  name: 'record_personality_profile',
  description: "Record the student's derived personality profile.",
  input_schema: {
    type: 'object',
    properties: {
      ocean: {
        type: 'object',
        description: 'Big Five trait scores, each 0-100.',
        properties: {
          openness:          { type: 'integer', minimum: 0, maximum: 100 },
          conscientiousness: { type: 'integer', minimum: 0, maximum: 100 },
          extraversion:      { type: 'integer', minimum: 0, maximum: 100 },
          agreeableness:     { type: 'integer', minimum: 0, maximum: 100 },
          neuroticism:       { type: 'integer', minimum: 0, maximum: 100 },
        },
        required: OCEAN_KEYS,
      },
      archetype:    { type: 'string', enum: ARCHETYPES },
      mbti:         { type: 'string', description: 'Closest Myers-Briggs 4-letter type, e.g. INFJ. Secondary/display-only.' },
      disc:         { type: 'string', description: 'Dominant DISC style — 1-2 letters from D, I, S, C. Secondary/display-only.' },
      summary:      { type: 'string', description: '2-3 sentence personality summary.' },
      strengths:    { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
      growth_areas: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
      roommate_fit: { type: 'string', description: 'The kind of roommate this person lives well with.' },
    },
    required: ['ocean', 'archetype', 'mbti', 'disc', 'summary', 'strengths', 'growth_areas', 'roommate_fit'],
  },
};

// ─── Anthropic call ──────────────────────────────────────────────────────
async function callAnthropic(transcript, voiceSection = '', writingSection = '', userId = null) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  let userContent = `Here are the student's quiz answers:\n\n${transcript}`;
  if (voiceSection) {
    userContent +=
      `\n\n──────────\nThe student also recorded a spoken voice interview. ` +
      `These open-ended, in-their-own-words answers are richer signal than ` +
      `the multiple-choice quiz — weight them heavily:\n\n${voiceSection}`;
  }
  if (writingSection) {
    userContent +=
      `\n\n──────────\nThe student also volunteered a personal writing sample ` +
      `(an essay, paper, or personal statement). Their natural written voice ` +
      `is high-value signal — weight it heavily:\n\n"${writingSection}"`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model:       MODEL,
        max_tokens:  1024,
        system:      SYSTEM_PROMPT,
        tools:       [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
        messages: [{
          role: 'user',
          content: userContent,
        }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Anthropic API ${res.status}: ${detail.slice(0, 300)}`);
    }

    const data = await res.json();
    const toolUse = (data.content || []).find(b => b.type === 'tool_use');
    if (!toolUse || !toolUse.input) throw new Error('no tool_use block in response');
    analytics.track(analytics.EVENTS.ai_call_made, userId, {
      persona:    'personality',
      tokens_in:  data.usage?.input_tokens ?? null,
      tokens_out: data.usage?.output_tokens ?? null,
      model:      MODEL,
    });
    return toolUse.input;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Output normalization ────────────────────────────────────────────────
function clampScore(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 50;
  return Math.min(100, Math.max(0, v));
}

function normalizeProfile(raw) {
  const ocean = {};
  for (const k of OCEAN_KEYS) ocean[k] = clampScore(raw && raw.ocean ? raw.ocean[k] : 50);

  const archetype = ARCHETYPES.includes(raw && raw.archetype) ? raw.archetype : 'adaptive_partner';
  const asArray = (v) => Array.isArray(v) ? v.filter(s => typeof s === 'string' && s.trim()).slice(0, 4) : [];

  // Secondary display-only labels — validated against their real shape so a
  // garbled model response just becomes null rather than junk text.
  const mbtiRaw = typeof raw?.mbti === 'string' ? raw.mbti.trim().toUpperCase() : '';
  const discRaw = typeof raw?.disc === 'string' ? raw.disc.trim().toUpperCase() : '';
  const mbti = /^[EI][NS][TF][JP]$/.test(mbtiRaw) ? mbtiRaw : null;
  const disc = /^[DISC]{1,2}$/.test(discRaw) ? discRaw : null;

  return {
    ocean,
    archetype,
    mbti,
    disc,
    summary:      typeof raw?.summary === 'string' ? raw.summary.trim() : '',
    strengths:    asArray(raw?.strengths),
    growth_areas: asArray(raw?.growth_areas),
    roommate_fit: typeof raw?.roommate_fit === 'string' ? raw.roommate_fit.trim() : '',
  };
}

// ─── Deterministic fallback ──────────────────────────────────────────────
// Used when the API key is missing or the call fails. Rough OCEAN estimate
// straight from the answer indices — approximate, but never blank, never
// crashes. `source: 'fallback'` flags it so it can be re-derived later.
function fallbackProfile(flat) {
  const get = (id) => (flat[id] === undefined || flat[id] === null ? null : flat[id]);
  // avg of normalized signals; signal = number 0..1, higher = more of trait
  const blend = (...signals) => {
    const ok = signals.filter(s => s !== null && Number.isFinite(s));
    if (ok.length === 0) return 0.5;
    return ok.reduce((a, b) => a + b, 0) / ok.length;
  };
  const norm = (v, max) => (v === null ? null : v / max);
  const inv  = (v, max) => (v === null ? null : 1 - v / max);

  // v5: prefer the DIRECT Big Five screens (Q15/25/35/45) when answered,
  // and fall back to the indirect-signal blend if they're missing (e.g.
  // partial-submit user who bailed before the personality section).
  // Direct readings:
  //   Q15  index 0 → introvert, 3 → extravert  → norm(_, 3)
  //   Q25  index 0 → high C,    3 → low C     → inv(_, 3)
  //   Q35  index 0 → high A,    3 → low A     → inv(_, 3)
  //   Q45  index 0 → stable,    3 → neurotic  → norm(_, 3)
  const extraversion = blend(
    norm(get(15), 3),                                  // direct
    norm(get(48), 3), norm(get(37), 3),                // indirect confirmations
  );
  const conscientiousness = blend(
    inv(get(25), 3),                                   // direct
    inv(get(50), 3), inv(get(57), 3),                  // indirect confirmations
  );
  const agreeableness = blend(
    inv(get(35), 3),                                   // direct
    get(14), get(31), get(32), inv(get(60), 3),        // indirect (forced-choice + repair)
  );
  const neuroticism = blend(
    norm(get(45), 3),                                  // direct
    inv(get(9), 2), inv(get(34), 2),
    norm(get(40), 3), norm(get(3), 3),                 // indirect confirmations
  );
  // Openness still has no direct screen — kept as the lighter
  // money-script-derived approximation. Add a direct Openness question
  // in a future iteration if it becomes a matching signal worth tuning.
  const openness          = blend(norm(get(56), 3) === null ? null : 0.4 + norm(get(56), 3) * 0.3);

  const ocean = {
    openness:          clampScore(openness * 100),
    conscientiousness: clampScore(conscientiousness * 100),
    extraversion:      clampScore(extraversion * 100),
    agreeableness:     clampScore(agreeableness * 100),
    neuroticism:       clampScore(neuroticism * 100),
  };

  const scores = {
    harmonizer:        ocean.agreeableness,
    structured_nester: ocean.conscientiousness,
    calm_anchor:       (100 - ocean.neuroticism) * 0.95,
    independent:       (100 - ocean.extraversion) * 0.9,
    social_builder:    ocean.extraversion,
    adaptive_partner:  ocean.openness * 0.9 + 12,
  };
  const archetype = Object.entries(scores).sort(([, a], [, b]) => b - a)[0][0];

  return normalizeProfile({
    ocean,
    archetype,
    summary: 'A preliminary profile based on your quiz answers. A fuller, AI-written version will appear once it finishes generating.',
    strengths: ['Completed the full compatibility quiz', 'Clear, consistent self-report'],
    growth_areas: ['Profile still being refined'],
    roommate_fit: 'Best matched with roommates whose lifestyle and communication style line up with your answers.',
  });
}

// ─── Public entry point ──────────────────────────────────────────────────
/**
 * Derive a personality profile from a student's quiz answers, optionally
 * enriched with their spoken voice-interview transcripts.
 * Always resolves — never rejects. Returns:
 *   { ocean, archetype, summary, strengths, growth_areas, roommate_fit,
 *     source: 'anthropic'|'fallback', model: string|null }
 *
 * @param {object} answers       - quiz answers (frontend wire shape)
 * @param {Array}  voiceAnswers  - optional [{ question, transcript }, ...]
 */
async function derivePersonality(answers, voiceAnswers = [], writingSample = '', userId = null) {
  const flat = flatten(answers);
  const voice = Array.isArray(voiceAnswers)
    ? voiceAnswers.filter(v => v && typeof v.transcript === 'string' && v.transcript.trim())
    : [];
  const writing = typeof writingSample === 'string' ? writingSample.trim() : '';

  if (Object.keys(flat).length < 5 && voice.length === 0 && !writing) {
    // Not enough answered to say anything meaningful.
    return { ...fallbackProfile(flat), source: 'fallback', model: null };
  }

  try {
    const transcript     = buildTranscript(flat);
    const voiceSection   = buildVoiceSection(voice);
    const writingSection = buildWritingSection(writing);
    const raw = await callAnthropic(transcript, voiceSection, writingSection, userId);
    return { ...normalizeProfile(raw), source: 'anthropic', model: MODEL };
  } catch (err) {
    console.error('[personality] derivation failed, using fallback:', err.message);
    analytics.track(analytics.EVENTS.ai_call_failed, userId, {
      persona: 'personality',
      error:   err.message,
      model:   MODEL,
    });
    return { ...fallbackProfile(flat), source: 'fallback', model: null };
  }
}

module.exports = { derivePersonality, ARCHETYPES, OCEAN_KEYS };
