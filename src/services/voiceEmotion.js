// ─── Hume AI voice-emotion analysis ──────────────────────────────────────
//
// Adds vocal INFLECTION to the voice interview — the advisor's point that
// "how they said it" carries signal the transcript alone misses. Each
// recorded answer's audio is sent to Hume's Expression Measurement
// (prosody) API; a compact list of the strongest emotion labels is folded
// into the AI personality derivation alongside the transcript.
//
// Best-effort: if HUME_API_KEY is missing, or the call fails / times out,
// analyzeVoiceEmotion() returns null and the voice interview proceeds on
// the transcript alone — exactly as before. Never throws.
//
// Pricing (2026): Hume Expression Measurement audio ≈ $0.064/min,
// pay-as-you-go — a ~3-minute interview is well under $0.20 per student.

const HUME_BASE        = 'https://api.hume.ai/v0/batch';
const POLL_INTERVAL_MS = 1500;
const MAX_POLLS        = 16;   // ~24s ceiling — best-effort, skip if slower
const TOP_EMOTIONS     = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startJob(audioBuffer, filename, key) {
  const form = new FormData();
  // Prosody = emotion read from vocal tone/inflection across the clip.
  form.append('json', JSON.stringify({ models: { prosody: {} } }));
  form.append('file', new Blob([audioBuffer]), filename);
  const res = await fetch(`${HUME_BASE}/jobs`, {
    method:  'POST',
    headers: { 'X-Hume-Api-Key': key },
    body:    form,
  });
  if (!res.ok) throw new Error(`Hume start ${res.status}`);
  const data = await res.json();
  if (!data || !data.job_id) throw new Error('Hume start: no job_id');
  return data.job_id;
}

async function waitForJob(jobId, key) {
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(`${HUME_BASE}/jobs/${jobId}`, {
      headers: { 'X-Hume-Api-Key': key },
    });
    if (!res.ok) continue;
    const data = await res.json();
    const status = data && data.state && data.state.status;
    if (status === 'COMPLETED') return;
    if (status === 'FAILED')    throw new Error('Hume job failed');
  }
  throw new Error('Hume job timed out');
}

async function getPredictions(jobId, key) {
  const res = await fetch(`${HUME_BASE}/jobs/${jobId}/predictions`, {
    headers: { 'X-Hume-Api-Key': key },
  });
  if (!res.ok) throw new Error(`Hume predictions ${res.status}`);
  return res.json();
}

// Recursively collect every { emotions: [{ name, score }] } array anywhere
// in the response — resilient to Hume's deep (and occasionally-shifting)
// prediction nesting.
function collectEmotionArrays(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectEmotionArrays(item, out);
    return;
  }
  if (Array.isArray(node.emotions)) out.push(node.emotions);
  for (const k of Object.keys(node)) collectEmotionArrays(node[k], out);
}

// Average each emotion across every segment, return the strongest few names.
function summarize(predictions) {
  const arrays = [];
  collectEmotionArrays(predictions, arrays);
  if (arrays.length === 0) return null;
  const totals = {};
  for (const arr of arrays) {
    for (const e of arr) {
      if (e && typeof e.name === 'string' && Number.isFinite(Number(e.score))) {
        totals[e.name] = (totals[e.name] || 0) + Number(e.score);
      }
    }
  }
  const names = Object.entries(totals)
    .sort(([, a], [, b]) => b - a)
    .slice(0, TOP_EMOTIONS)
    .map(([name]) => name);
  return names.length ? names : null;
}

/**
 * Analyze the vocal emotion of one recorded answer.
 * Returns an array of the strongest emotion names (e.g. ['Calmness',
 * 'Interest', 'Joy']) or null when unavailable. Never throws.
 */
async function analyzeVoiceEmotion(audioBuffer, filename = 'answer.webm') {
  const key = process.env.HUME_API_KEY;
  if (!key) return null;
  try {
    const jobId = await startJob(audioBuffer, filename, key);
    await waitForJob(jobId, key);
    const predictions = await getPredictions(jobId, key);
    return summarize(predictions);
  } catch (err) {
    console.error('[voiceEmotion] failed:', err.message);
    return null;
  }
}

module.exports = { analyzeVoiceEmotion };
