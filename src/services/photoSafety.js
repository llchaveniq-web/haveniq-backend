// Claude-vision photo safety + quality verdict.
//
// Extracted verbatim from the inline POST /users/me/photo/quality-check handler
// so BOTH that route and the multi-photo gallery upload run ONE implementation
// (single source of truth for the prompt + parsing + soft-fail policy).
//
// PURE w.r.t. the DB / Cloudinary — it only returns the verdict. The caller
// decides side effects (delete the asset, null photo_url, pick an HTTP status).
//
// SOFT-FAIL policy: on a missing key, non-200, unparseable body, or any thrown
// error, return { safe: true, ... }. We never block a user when Claude is
// unreachable — an outage locking out a legitimate user is worse for the
// product than the rare borderline photo slipping through. Rejection requires
// Claude to EXPLICITLY return safe:false.

const { stripDashes } = require('../lib/textStyle');

const SOFT_FAIL = Object.freeze({
  safe: true, safety_reason: null, score: null,
  summary: 'Quality check unavailable', issues: [], suggestion: null, good_enough: true,
});

const PROMPT = `You are scoring a college student's profile photo for HavenIQ, a roommate-matching app. Be HONEST but KIND — students get demoralized by harsh photo feedback. The goal is to help them get more matches, not to grade their attractiveness.

You have TWO jobs in this single call:
  A. SAFETY GATE — flag the photo as unsafe ONLY if it's clearly inappropriate for a school-affiliated roommate app.
  B. QUALITY SCORE — friendly, observational feedback on whether it'll help them match.

═══ JOB A: SAFETY GATE ═══

Mark "safe": false ONLY if the photo clearly contains:
  - Explicit nudity (genitals, bare breasts, sexual acts)
  - Sexual or suggestive content (lingerie, swimwear posed sexually, "thirst trap" framing)
  - Weapons brandished or pointed (guns, knives held aggressively)
  - Drug use (visible drugs, paraphernalia, smoking marijuana on-camera)
  - Hate symbols (swastikas, Confederate flag worn as statement, etc.)
  - Graphic violence, blood, injury
  - Photos of minors clearly under ~16 in adult-platform context

DO NOT mark unsafe for:
  - Beach photos in normal swimwear (not sexually posed)
  - Casual alcohol in background (a beer at a tailgate is fine)
  - Athletic / gym photos
  - Costumes, edgy fashion, tattoos, piercings
  - Anything that's just unflattering or low-quality — that's job B

When unsafe, fill safety_reason with ONE short sentence the user will see (e.g. "This photo contains content that isn't appropriate for a school roommate platform — please pick a different photo.").
When safe (default), set safety_reason to null.

═══ JOB B: QUALITY ASSESS (only if safe) ═══

WHAT TO ASSESS (in order of importance for a roommate-matching profile):
  1. Is the person clearly visible? Face + at least shoulders, well-lit, in focus
  2. Are their eyes visible? (sunglasses are a soft red flag, esp. indoors)
  3. Is it a SOLO photo? (group photos are confusing — who is the user?)
  4. Is the framing reasonable? (Not a tiny dot from across a room, not a selfie 2 inches from the lens)
  5. Does it look recent and authentic? (Filter-heavy or AI-generated reads as inauthentic)

WHAT'S FINE:
  - Plain background, slight smile, normal clothes — most photos
  - Slight cropping, casual lighting, hat indoors
  - Not posed / professional — students aren't supposed to look like LinkedIn headshots

WHAT'S A REAL PROBLEM:
  - Face not visible (back of head, way too dark, hands over face)
  - Multiple equally-prominent people with no clear "main"
  - Major facial obstruction (full sunglasses + hat + mask)
  - Heavily blurry / out of focus
  - Generic stock/AI photo

═══ RESPONSE FORMAT ═══

Respond ONLY with JSON. No markdown:
{
  "safe":           <boolean — false ONLY for the explicit categories listed above; default true>,
  "safety_reason":  "<one short user-facing sentence if unsafe, else null>",
  "score":          <integer 0-100, where 70+ = "good enough">,
  "summary":        "<one short, friendly, observational sentence — like a friend texting>",
  "issues":         ["<short issue 1>", "<short issue 2>"],     // 0-3 items; empty array if photo is fine
  "suggestion":     "<one actionable suggestion, or null if photo is fine>",
  "good_enough":    <boolean — true if score >= 70 OR if it's borderline but the issues are minor>
}

Examples of good summaries:
  - "Clear face, good light — solid choice."
  - "Hard to see your eyes with the sunglasses on."
  - "Cool photo but it's hard to tell which person is you."
Examples of bad summaries (do NOT write like this):
  - "This photo is bad."
  - "You should retake this photo."
  - "Your face is obscured."  (clinical, not warm)`;

/**
 * Grade a Cloudinary-hosted photo. Returns:
 *   { safe, safety_reason, score, summary, issues, suggestion, good_enough }
 * `safe` is false ONLY when Claude explicitly returns safe:false; every failure
 * mode soft-fails to safe:true (see policy above).
 */
async function checkPhotoSafety(url) {
  const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY ?? '').replace(/[^!-~]/g, '');
  if (!ANTHROPIC_KEY) return { ...SOFT_FAIL };

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url } },
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('[photo-safety] Anthropic', r.status, text.slice(0, 200));
      return { ...SOFT_FAIL };
    }
    const j = await r.json();
    const text = (j.content || []).find((b) => b.type === 'text')?.text ?? '{}';
    let payload;
    try {
      payload = JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim());
    } catch {
      return { ...SOFT_FAIL };
    }

    // Safety default TRUE — the model must EXPLICITLY return safe:false to reject.
    const isUnsafe = payload.safe === false;
    return {
      safe:          !isUnsafe,
      safety_reason: isUnsafe && typeof payload.safety_reason === 'string'
        ? payload.safety_reason.slice(0, 300)
        : null,
      score:         typeof payload.score === 'number' ? Math.max(0, Math.min(100, Math.round(payload.score))) : null,
      summary:       typeof payload.summary === 'string' ? stripDashes(payload.summary.slice(0, 200)) : '',
      issues:        Array.isArray(payload.issues) ? payload.issues.slice(0, 3).map((s) => stripDashes(String(s))) : [],
      suggestion:    typeof payload.suggestion === 'string' ? stripDashes(payload.suggestion.slice(0, 200)) : null,
      good_enough:   payload.good_enough !== false,
    };
  } catch (err) {
    console.error('[photo-safety] failed:', err.message);
    return { ...SOFT_FAIL };
  }
}

module.exports = { checkPhotoSafety };
