// ─── Text-insight extractor (deep-matching #5: LLM grounded signal) ─────────
//
// Reads a student's OWN free text (bio, open-ended quiz answers, voice-intro
// transcript, writing sample) and asks an LLM to score a small, FIXED set of
// living-habits constructs in [0,1], each with a one-line rationale. The numeric
// vector becomes candidate features for the SAME outcome-trained gate as #2/#3 —
// it is the richer successor to linguisticFingerprint, NOT an "AI personality
// reading." Constructs are living-habits only; never sensitive/protected traits.
//
// HARD RULES:
//  • CONSENT: extract ONLY for users whose latest `textInsight` consent is true
//    (default OFF). On withdrawal, purge the derived vector (see /telemetry/consent).
//  • DERIVED-ONLY: persist ONLY the numbers + rationales. NEVER the raw text
//    (same rule as linguisticFingerprint). A source_hash detects text changes so
//    we re-extract; the text itself is never stored.
//  • STRICT JSON: any LLM output that isn't the exact expected shape is rejected.
//  • GATED: a construct enters scoring ONLY once it beats the no-feature model on
//    held-out outcomes (see scoring.js + dimensionBasis.fitConstructGated). Until
//    then its weight is 0 — scoring is exactly today, bit-for-bit.
//
// pool/anthropic are reached lazily inside the DB/network functions so the pure
// helpers (CONSTRUCTS / validateExtraction / buildPrompt / sourceHash) import
// without `pg`.

const crypto = require('crypto');

// The consent category the app must log (POST /telemetry/consent) to opt in.
const TEXT_INSIGHT_CONSENT = 'textInsight';

// Fixed construct list — living-habits dimensions only. Each scored 0..1 with the
// anchors below. NEVER add sensitive/protected attributes (mental health,
// sexuality, religion, politics, health, etc.).
const CONSTRUCTS = [
  { key: 'directness',           low: 'indirect / hint-dropping', high: 'direct, says things plainly' },
  { key: 'warmth',               low: 'reserved / cool',          high: 'warm, friendly to live with' },
  { key: 'planfulness',          low: 'spontaneous / go-with-the-flow', high: 'organized, plans ahead' },
  { key: 'conflict_approach',    low: 'avoids conflict',          high: 'addresses friction head-on' },
  { key: 'tidiness_orientation', low: 'relaxed about mess',       high: 'cares a lot about a tidy space' },
  { key: 'social_energy',        low: 'quiet / private at home',  high: 'social, likes hosting' },
  { key: 'adaptability',         low: 'set in routines',          high: 'flexible, rolls with change' },
];
const CONSTRUCT_KEYS = CONSTRUCTS.map(c => c.key);

// Bump when the prompt or construct set changes so re-extraction is forced.
const PROMPT_VERSION = 'ti-v1';
const MODEL = process.env.TEXT_INSIGHT_MODEL || 'claude-haiku-4-5-20251001';
const MODEL_VERSION = `${MODEL}:${PROMPT_VERSION}`;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

function buildPrompt(text) {
  const lines = CONSTRUCTS.map(c => `  "${c.key}": 0=${c.low} … 1=${c.high}`).join('\n');
  return [
    'You read a college student\'s own words and rate their LIVING-HABITS communication style for roommate matching.',
    'Rate ONLY these constructs, each a calibrated scalar in [0,1], plus a one-line rationale grounded in the text:',
    lines,
    '',
    'HARD RULES:',
    '- Output STRICT JSON only, no prose, exactly this shape:',
    '  { "<construct>": { "value": <0..1 number>, "rationale": "<one short sentence>" }, ... } for ALL constructs above.',
    '- Infer ONLY living-habits/communication style. NEVER infer or mention mental health, sexuality, religion, politics, race, or any protected/sensitive attribute. If the text hints at those, ignore it.',
    '- If the text is too thin to judge a construct, use 0.5 and say so in the rationale. Never invent specifics.',
    '',
    'STUDENT TEXT:',
    '"""',
    String(text || '').slice(0, 6000),
    '"""',
  ].join('\n');
}

// Strict validator: returns { vector, rationales } only when EVERY construct is
// present with a finite value in [0,1] and a non-empty string rationale.
// Anything else (missing key, extra junk tolerated, wrong types, out of range)
// → null. A hallucinated/malformed shape is rejected, not coerced.
function validateExtraction(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const vector = {}, rationales = {};
  for (const key of CONSTRUCT_KEYS) {
    const entry = obj[key];
    if (!entry || typeof entry !== 'object') return null;
    const v = entry.value;
    const r = entry.rationale;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return null;
    if (typeof r !== 'string' || r.trim().length === 0) return null;
    vector[key] = Math.round(v * 1000) / 1000;
    rationales[key] = r.trim().slice(0, 240);
  }
  return { vector, rationales };
}

function sourceHash(text) {
  return crypto.createHash('sha256').update(`${PROMPT_VERSION}:${String(text || '')}`).digest('hex');
}

// ── Network (best-effort; missing key / error → null, never throws up) ───────
async function callAnthropic(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return (j.content || []).find(b => b.type === 'text')?.text ?? null;
  } catch (e) {
    console.error('[textInsight] LLM call failed:', e.message);
    return null;
  }
}

// ── Consent (latest consent_log row for the category is the current state) ───
async function hasConsent(userId) {
  try {
    const pool = require('../db/pool');
    const { rows } = await pool.query(
      `SELECT allowed FROM consent_log
        WHERE user_id = $1 AND category = $2
        ORDER BY created_at DESC LIMIT 1`,
      [userId, TEXT_INSIGHT_CONSENT],
    );
    return rows[0]?.allowed === true;
  } catch (e) {
    console.error('[textInsight] consent check failed:', e.message);
    return false; // fail CLOSED — never extract on an error
  }
}

// Gather the user's own free text. Returns '' when there's nothing to read.
async function gatherSourceText(userId) {
  const pool = require('../db/pool');
  const parts = [];
  try {
    const { rows: u } = await pool.query('SELECT bio FROM users WHERE id = $1', [userId]);
    if (u[0]?.bio) parts.push(String(u[0].bio));
    const { rows: q } = await pool.query(
      'SELECT answers, voice_answers, writing_sample FROM quiz_answers WHERE user_id = $1', [userId]);
    if (q[0]) {
      const { answers, voice_answers, writing_sample } = q[0];
      if (writing_sample) parts.push(String(writing_sample));
      if (answers && typeof answers === 'object') {
        for (const v of Object.values(answers)) {
          if (v && typeof v === 'object' && v.type === 'text' && typeof v.text === 'string') parts.push(v.text);
        }
      }
      if (Array.isArray(voice_answers)) {
        for (const va of voice_answers) {
          if (va && typeof va.transcript === 'string') parts.push(va.transcript);
        }
      }
    }
  } catch (e) {
    console.error('[textInsight] gather failed:', e.message);
  }
  return parts.join('\n\n').trim();
}

async function persist(userId, vector, rationales, hash) {
  const pool = require('../db/pool');
  await pool.query(
    `INSERT INTO text_insight_features (user_id, vector, rationales, model_version, source_hash, computed_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET vector = EXCLUDED.vector, rationales = EXCLUDED.rationales,
           model_version = EXCLUDED.model_version, source_hash = EXCLUDED.source_hash,
           computed_at = NOW()`,
    [userId, JSON.stringify(vector), JSON.stringify(rationales), MODEL_VERSION, hash],
  );
}

async function purge(userId) {
  try {
    const pool = require('../db/pool');
    await pool.query('DELETE FROM text_insight_features WHERE user_id = $1', [userId]);
  } catch (e) {
    console.error('[textInsight] purge failed:', e.message);
  }
}

/**
 * Extract + persist a user's text-insight vector, honoring consent and skipping
 * unchanged text. Dependencies are injectable so the consent gate / strict-JSON
 * rejection / derived-only persistence are unit-testable without DB or network.
 * Returns a short status string. NEVER stores raw text.
 */
async function extractForUser(userId, deps = {}) {
  const _consent = deps.consent || hasConsent;
  const _gather = deps.gather || gatherSourceText;
  const _currentHash = deps.currentHash || (async (uid) => {
    try {
      const pool = require('../db/pool');
      const { rows } = await pool.query('SELECT source_hash FROM text_insight_features WHERE user_id = $1', [uid]);
      return rows[0]?.source_hash || null;
    } catch { return null; }
  });
  const _llm = deps.llm || callAnthropic;
  const _persist = deps.persist || persist;
  const _purge = deps.purge || purge;

  if (!(await _consent(userId))) { await _purge(userId); return 'no-consent'; }
  const text = await _gather(userId);
  if (!text) { await _purge(userId); return 'no-text'; }
  const hash = sourceHash(text);
  if ((await _currentHash(userId)) === hash) return 'unchanged';

  const out = await _llm(buildPrompt(text));
  const parsed = validateExtraction(out);
  if (!parsed) return 'llm-rejected'; // malformed / hallucinated shape → store nothing

  await _persist(userId, parsed.vector, parsed.rationales, hash);
  return 'extracted';
}

// ── Scoring/serve/train accessors ────────────────────────────────────────────
async function loadFeatures(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (ids.length === 0) return {};
  try {
    const pool = require('../db/pool');
    const { rows } = await pool.query(
      'SELECT user_id, vector FROM text_insight_features WHERE user_id = ANY($1::uuid[])', [ids]);
    const out = {};
    for (const r of rows) if (r.vector && typeof r.vector === 'object') out[String(r.user_id)] = r.vector;
    return out;
  } catch (e) {
    console.error('[textInsight] loadFeatures failed:', e.message);
    return {};
  }
}

// Certified construct shapes the scorer applies, keyed by construct. Only
// certified rows; absent ⇒ that construct contributes 0 (cold-start). Cached.
let _modelCache = null, _modelCacheAt = 0;
const MODEL_TTL_MS = 10 * 60 * 1000;
async function loadCertifiedModels({ force = false } = {}) {
  if (!force && _modelCache && Date.now() - _modelCacheAt < MODEL_TTL_MS) return _modelCache;
  const out = {};
  try {
    const pool = require('../db/pool');
    const { rows } = await pool.query(
      'SELECT construct, shape FROM text_insight_models WHERE certified = TRUE AND shape IS NOT NULL');
    for (const r of rows) {
      if (!r.shape || !r.shape.baseline || !r.shape.basis) continue;
      out[r.construct] = { certified: true, baseline: r.shape.baseline, basis: r.shape.basis };
    }
  } catch (e) {
    console.error('[textInsight] loadCertifiedModels failed:', e.message);
    return {};
  }
  _modelCache = out; _modelCacheAt = Date.now();
  return out;
}

// Build per-construct training records from pairing_outcomes serve snapshots.
// features.llm[construct] = [cA, cB] captured at serve time; labeled by outcome.
function buildConstructRecords(rows, labelOutcome) {
  const perC = {}; for (const k of CONSTRUCT_KEYS) perC[k] = [];
  for (const row of rows) {
    const label = labelOutcome(row);
    if (label === null) continue;
    const llm = row.features && row.features.llm;
    if (!llm || typeof llm !== 'object') continue;
    for (const k of CONSTRUCT_KEYS) {
      const pair = llm[k];
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const a = Number(pair[0]), b = Number(pair[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      perC[k].push({ a, b, success: label });
    }
  }
  return perC;
}

// Fit + gate each construct against held-out outcomes; persist to
// text_insight_models. No labeled outcomes ⇒ every construct uncertified ⇒
// scoring unchanged, bit-for-bit.
async function trainFeatures() {
  const pool = require('../db/pool');
  const { fitConstructGated } = require('./dimensionBasis');
  const { labelOutcome } = require('./dimensionModel');
  const { rows } = await pool.query(
    `SELECT features, moved_in_at, room_change_at, blocked_at, ghosted_at
       FROM pairing_outcomes WHERE features IS NOT NULL`);
  const perC = buildConstructRecords(rows, labelOutcome);
  const summary = [];
  for (const construct of CONSTRUCT_KEYS) {
    const shape = fitConstructGated(perC[construct] || []);
    const stored = shape.certified ? { baseline: shape.baseline, basis: shape.basis } : null;
    try {
      await pool.query(
        `INSERT INTO text_insight_models (construct, certified, type, n, auc, shape, reason, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
         ON CONFLICT (construct) DO UPDATE
           SET certified=EXCLUDED.certified, type=EXCLUDED.type, n=EXCLUDED.n, auc=EXCLUDED.auc,
               shape=EXCLUDED.shape, reason=EXCLUDED.reason, updated_at=NOW()`,
        [construct, shape.certified, shape.type, shape.n,
         Number.isFinite(shape.auc) ? shape.auc : null,
         stored ? JSON.stringify(stored) : null, shape.reason]);
    } catch (e) {
      console.error(`[textInsight] persist construct=${construct} failed:`, e.message);
    }
    summary.push({ construct, certified: shape.certified, n: shape.n, auc: shape.auc });
  }
  return summary;
}

async function getOwnInsight(userId) {
  if (!(await hasConsent(userId))) return null;
  try {
    const pool = require('../db/pool');
    const { rows } = await pool.query(
      'SELECT vector, rationales, model_version, computed_at FROM text_insight_features WHERE user_id = $1', [userId]);
    if (!rows[0]) return null;
    return { constructs: rows[0].vector, rationales: rows[0].rationales,
             modelVersion: rows[0].model_version, computedAt: rows[0].computed_at };
  } catch (e) {
    console.error('[textInsight] getOwnInsight failed:', e.message);
    return null;
  }
}

module.exports = {
  TEXT_INSIGHT_CONSENT, CONSTRUCTS, CONSTRUCT_KEYS, MODEL_VERSION, PROMPT_VERSION,
  buildPrompt, validateExtraction, sourceHash,
  hasConsent, gatherSourceText, persist, purge, extractForUser,
  loadFeatures, loadCertifiedModels, buildConstructRecords, trainFeatures, getOwnInsight,
};
