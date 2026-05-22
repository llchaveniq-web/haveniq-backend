// ─── ElevenLabs voice integration ────────────────────────────────────────
//
// Powers the optional "voice interview": the app reads questions aloud
// (Text-to-Speech), the student answers by speaking, and we transcribe the
// recorded audio (Speech-to-Text). The transcript then feeds the
// personality-derivation service for extra depth.
//
// Best-effort: if ELEVENLABS_API_KEY is missing, every call throws a clear
// error and the caller falls back to the normal text quiz — the voice
// interview is always optional, never a hard dependency.

const ELEVEN_BASE  = 'https://api.elevenlabs.io/v1';
// All overridable via env. Defaults: "Rachel" (a stable public ElevenLabs
// voice), the multilingual v2 TTS model, and the scribe_v1 STT model.
const VOICE_ID     = process.env.ELEVENLABS_VOICE_ID  || '21m00Tcm4TlvDq8ikWAM';
const TTS_MODEL    = process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2';
const STT_MODEL    = process.env.ELEVENLABS_STT_MODEL || 'scribe_v1';
const CALL_TIMEOUT = 30000;

function apiKey() {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new Error('ELEVENLABS_API_KEY not set');
  return k;
}

/**
 * Text -> spoken audio. Returns an mp3 Buffer the client can play.
 */
async function textToSpeech(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT);
  try {
    const res = await fetch(`${ELEVEN_BASE}/text-to-speech/${VOICE_ID}`, {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'xi-api-key':   apiKey(),
        'content-type': 'application/json',
        'accept':       'audio/mpeg',
      },
      body: JSON.stringify({ text, model_id: TTS_MODEL }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`ElevenLabs TTS ${res.status}: ${detail.slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Spoken audio (Buffer) -> transcript. Returns { text }.
 * `filename` only carries the extension hint for ElevenLabs.
 */
async function transcribe(audioBuffer, filename = 'answer.webm') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT);
  try {
    const form = new FormData();
    form.append('model_id', STT_MODEL);
    form.append('file', new Blob([audioBuffer]), filename);

    const res = await fetch(`${ELEVEN_BASE}/speech-to-text`, {
      method:  'POST',
      signal:  controller.signal,
      headers: { 'xi-api-key': apiKey() },   // fetch sets the multipart boundary
      body:    form,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`ElevenLabs STT ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    return { text: (data && typeof data.text === 'string') ? data.text.trim() : '' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { textToSpeech, transcribe };
