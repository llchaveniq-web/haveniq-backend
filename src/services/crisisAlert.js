// ═══════════════════════════════════════════════════════════════════════════
//  Crisis escalation — alert a human when a student's message trips the
//  self-harm / crisis detector.
//
//  Design + duty-of-care notes:
//   - Fires ONCE per user per DEBOUNCE window (6h) so a distressed run of
//     messages doesn't spam the safety channel.
//   - Sends to the ops Discord (immediate) AND the safety inbox (durable). Both
//     best-effort — a hiccup must never break message send.
//   - The detector is a HEURISTIC (false positives happen), so the alert says
//     "may need support," not a diagnosis. A human decides whether to reach out.
//   - This does NOT block or surveil the student's conversation; it only surfaces
//     a check-in signal to staff. The student still gets the supportive 988 card.
//
//  Deps injectable (fetchFn / sendEmail / now / discordHook / to) for testing.
// ═══════════════════════════════════════════════════════════════════════════

const { sendCrisisAlertEmail } = require('./email');

const DEBOUNCE_MS = 6 * 60 * 60 * 1000;   // one alert per user per 6h
const lastAlertAt = new Map();

function crisisAlertEmailTarget() {
  return process.env.CRISIS_ALERT_EMAIL
    || process.env.SAFETY_ALERT_EMAIL
    || (process.env.FOUNDER_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean)[0]
    || 'support@haveniq.org';
}

async function maybeAlertCrisis(user, conversationId, deps = {}) {
  const {
    now = Date.now,
    fetchFn = fetch,
    sendEmail = sendCrisisAlertEmail,
    discordHook = process.env.DISCORD_WEBHOOK_URL || '',
    to = crisisAlertEmailTarget(),
  } = deps;

  if (!user || !user.id) return { alerted: false, reason: 'no_user' };

  const t = now();
  const prev = lastAlertAt.get(user.id) || 0;
  if (t - prev < DEBOUNCE_MS) return { alerted: false, reason: 'debounced' };
  lastAlertAt.set(user.id, t);

  const name  = user.first_name || 'A student';
  const email = user.email || 'unknown';

  if (discordHook) {
    await fetchFn(discordHook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: '⚠️ Possible crisis signal — a student may need support',
          description: `A message from **${name}** (${email}) tripped the self-harm/crisis detector. A short human check-in can matter. Heuristic detector — use judgment; 911 / campus safety for immediate danger.`,
          color: 0xC0392B,
          footer: { text: 'Crisis escalation • debounced 6h/user • not a diagnosis' },
        }],
      }),
    }).catch(() => {});
  }

  try {
    await sendEmail({ to, studentName: name, studentEmail: email, studentId: user.id, conversationId });
  } catch { /* best-effort */ }

  return { alerted: true };
}

// Test-only: reset the debounce memory between cases.
function _resetForTest() { lastAlertAt.clear(); }

module.exports = { maybeAlertCrisis, crisisAlertEmailTarget, _resetForTest, DEBOUNCE_MS };
