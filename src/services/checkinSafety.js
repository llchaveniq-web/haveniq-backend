// Shared safety-paging for roommate check-in free text — used by both
// matchOutcomes.js's structured check-in notes and pulses.js's 30/60/90-day
// pulse notes. A note that trips the crisis (self-harm) or threat filter
// shouldn't wait for someone to pull a review queue — page the founder now.
// Fire-and-forget: a webhook failure must never reach the student, and the
// excerpt sent is the ALREADY PII-redacted/sanitized note, capped short.
//
// Extracted from matchOutcomes.js so a second consumer (pulses.js) can't
// silently drift from this exact crisis/threat logic — the kind of thing
// that must behave identically everywhere it's checked.

const sentry = require('../utils/sentry');
const { screenMessage, detectThreatSignal } = require('../lib/contentFilter');
const DISCORD_HOOK = process.env.DISCORD_WEBHOOK_URL || '';

function maybePageSafety({ reporterId, rawNote, sanitizedNote, stage, source }) {
  try {
    if (!rawNote || !rawNote.trim()) return;
    const screen = screenMessage(rawNote);
    const isCrisis = !!screen.crisis;                                      // self-harm language
    // Deliberately broader than screenMessage's own threat category — a
    // check-in note reporting on someone ELSE'S behavior ("my roommate
    // said he will hurt you") has no first-person "I'll" for the stricter,
    // block-worthy rule to gate on. See detectThreatSignal's own comment.
    const isThreat = detectThreatSignal(rawNote);
    if (!isCrisis && !isThreat) return;
    pageCheckinSafetyFlag({
      reporterId,
      stage: stage || null,
      kind: isCrisis ? 'crisis' : 'threat',
      noteExcerpt: (sanitizedNote || '').slice(0, 300),
      source: source || 'checkin',
    }).catch(() => {});
  } catch { /* never throw into the request path */ }
}

async function pageCheckinSafetyFlag({ reporterId, stage, kind, noteExcerpt, source }) {
  const crisis = kind === 'crisis';
  try {
    sentry.captureError(new Error('signal:checkin_safety_flag'), { kind, reporterId, stage, source });
  } catch { /* best-effort */ }
  if (!DISCORD_HOOK) return;
  await fetch(DISCORD_HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: crisis
          ? '\u{1F6A8} signal:checkin_safety_flag — CRISIS'
          : '\u{1F6A8} signal:checkin_safety_flag — THREAT',
        description: crisis
          ? 'A student’s check-in note tripped the self-harm / crisis filter. Reach out — they may need support (988).'
          : 'A student’s check-in note tripped the threat filter. Review and follow up.',
        color: 0xC0392B,
        fields: [
          { name: 'Reporter (user id)', value: `\`${reporterId || '?'}\``, inline: true },
          { name: 'Stage', value: `\`${stage || '?'}\``, inline: true },
          { name: 'Source', value: `\`${source || 'checkin'}\``, inline: true },
          { name: 'Note (PII-redacted)', value: (noteExcerpt || '—').slice(0, 900), inline: false },
        ],
        footer: { text: 'Check-in safety • paged on crisis/threat filter hit' },
      }],
    }),
  }).catch(() => {});
}

module.exports = { maybePageSafety, pageCheckinSafetyFlag };
