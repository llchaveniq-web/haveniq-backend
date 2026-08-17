// Shared free-text cleaning for roommate check-in notes — used by both
// matchOutcomes.js's structured check-in notes and pulses.js's 30/60/90-day
// pulse notes (pulses.js previously had NO cleaning at all: no PII
// redaction, no length cap, no content screening). Caps length, redacts
// obvious PII (so a note can't become an accidental way to hand out a phone
// number/email/handle to a roommate), and replaces egregious content with a
// placeholder rather than rejecting the whole submission — the note is
// optional context, the structured status/outcome is the point.
const { screenMessage } = require('./contentFilter');

function sanitizeNoteText(rawNote) {
  if (typeof rawNote !== 'string' || !rawNote.trim()) return null;
  let note = rawNote.trim().slice(0, 2000)
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi, '[redacted]')  // emails
    .replace(/(\+?\d[\d\s().-]{7,}\d)/g, '[redacted]')        // phone numbers
    .replace(/@[A-Za-z0-9_.]{2,}/g, '[redacted]');            // social handles
  try {
    const screen = screenMessage(note);
    if (screen && screen.action === 'block') note = '[removed by safety filter]';
  } catch { /* screening is best-effort; never block the structured submission */ }
  return note;
}

module.exports = { sanitizeNoteText };
