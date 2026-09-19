// ═══════════════════════════════════════════════════════════════════════════
//  Frozen lifecycle-email templates — the Grow loop's ONLY send-time copy.
//
//  These are FIXED and human-reviewed in code review. The autonomous sender
//  never generates copy at send time and there is no per-user free text — the
//  only variable is the recipient's OWN real first name. That is the honesty
//  guarantee: a lifecycle email can never state a traction/match number,
//  because none of these templates contain one. (A test asserts the subject +
//  text bodies are number-free.)
//
//  One template per real-state segment (see lifecycleSegments.js). Each segment
//  is defined so its template's claim is TRUE for every recipient:
//   - quiz_incomplete: they really have not finished the quiz.
//   - matches_waiting: they really have >=1 computed match and have connected
//     with none — so "your matches are ready" is true without stating a count.
//   - invited_nobody: they really have zero successful referrals.
// ═══════════════════════════════════════════════════════════════════════════

const APP_URL   = process.env.APP_PUBLIC_URL || 'https://app.haveniq.org';
const FROM       = 'HavenIQ <noreply@haveniq.org>';
// CAN-SPAM: lifecycle/marketing mail carries an unsubscribe path. There is no
// one-click token endpoint yet, so we use a mailto opt-out + a List-Unsubscribe
// header (honored by Gmail/Apple Mail). A spam complaint already sets
// email_undeliverable=TRUE, which the sender treats as opted-out.
const UNSUB_MAILTO = 'mailto:support@haveniq.org?subject=unsubscribe';
// {{unsubUrl}} is filled per-recipient at render time with a signed one-click
// unsubscribe link (falls back to the mailto if a caller omits it).
const FOOTER_TEXT  = "\n\nYou're receiving this as a verified HavenIQ member. "
  + 'To stop these occasional nudges, unsubscribe here: {{unsubUrl}}';

function shell(bodyHtml) {
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f0e8;margin:0;padding:40px 20px;">
    <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
      <div style="background:#3f6a57;padding:28px;text-align:center;">
        <p style="font-size:26px;font-weight:800;color:#fff;margin:0;">HavenIQ ✦</p>
      </div>
      <div style="padding:32px;color:#22201d;font-size:15px;line-height:1.6;">${bodyHtml}</div>
      <div style="background:#f4f0e8;padding:18px 32px;text-align:center;border-top:1px solid #efe8dd;">
        <p style="color:#625c52;font-size:12px;margin:0;">You're receiving this as a verified HavenIQ member.
          <a href="{{unsubUrl}}" style="color:#3f6a57;">Unsubscribe</a>.</p>
      </div>
    </div></body></html>`;
}

// Templates keyed by segment id. Bodies use {{firstName}} — the recipient's own
// name — and NOTHING else. No counts, no fabricated stats.
//
// No dashes anywhere in this copy (house style). Each button opens the screen
// the email is about, not the app root: a signed in student lands right there,
// a signed out one goes to sign in exactly as the root link would. The invite
// link lives on /circle ("bring your people" on the Profile tab); an earlier
// version said "it's in your Settings", where it has never been.
const TEMPLATES = {
  quiz_incomplete: {
    id: 'quiz_incomplete_v1',
    segment: 'quiz_incomplete',
    subject: 'Your HavenIQ matches are one quiz away',
    text: `Hi {{firstName}},\n\nYou signed up for HavenIQ but haven't finished the compatibility quiz yet. It's the one thing standing between you and your roommate matches, and it only takes a few minutes.\n\nPick it back up: ${APP_URL}\n\nHavenIQ${FOOTER_TEXT}`,
    html: shell(`<p>Hi {{firstName}},</p><p>You signed up for HavenIQ but haven't finished the compatibility quiz yet. It's the one thing standing between you and your roommate matches, and it only takes a few minutes.</p><p><a href="${APP_URL}" style="color:#3f6a57;font-weight:600;">Pick up your quiz →</a></p><p style="color:#625c52;">HavenIQ</p>`),
  },
  matches_waiting: {
    id: 'matches_waiting_v1',
    segment: 'matches_waiting',
    subject: 'Your roommate matches are ready ✦',
    text: `Hi {{firstName}},\n\nYour compatibility quiz is done and your matches are ready to browse. Open HavenIQ to see who you lined up with and send your first connect request.\n\n${APP_URL}/matches\n\nHavenIQ${FOOTER_TEXT}`,
    html: shell(`<p>Hi {{firstName}},</p><p>Your compatibility quiz is done and your matches are ready to browse. Open HavenIQ to see who you lined up with and send your first connect request.</p><p><a href="${APP_URL}/matches" style="color:#3f6a57;font-weight:600;">See your matches →</a></p><p style="color:#625c52;">HavenIQ</p>`),
  },
  invited_nobody: {
    id: 'invited_nobody_v1',
    segment: 'invited_nobody',
    subject: 'Know someone still looking for a roommate?',
    text: `Hi {{firstName}},\n\nThe more good people on HavenIQ, the better everyone's matches. If a friend is still figuring out their housing, send them your invite link. It's under "bring your people" on your Profile tab.\n\n${APP_URL}/circle\n\nHavenIQ${FOOTER_TEXT}`,
    html: shell(`<p>Hi {{firstName}},</p><p>The more good people on HavenIQ, the better everyone's matches. If a friend is still figuring out their housing, send them your invite link. It's under "bring your people" on your Profile tab.</p><p><a href="${APP_URL}/circle" style="color:#3f6a57;font-weight:600;">Get your invite link →</a></p><p style="color:#625c52;">HavenIQ</p>`),
  },
};

// The first name is whatever the student typed into their profile, so it is
// escaped before it goes into the HTML part. The text part needs no escaping.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

// List-Unsubscribe header value the sender attaches to every lifecycle email.
const LIST_UNSUBSCRIBE = `<${UNSUB_MAILTO}>`;

// Render a template for one recipient. The ONLY substitutions are their real
// first name and their signed unsubscribe URL — never any other value. Falls
// back to a neutral greeting and the mailto opt-out if either is omitted.
function render(template, { firstName, unsubUrl } = {}) {
  const name = (firstName && String(firstName).trim()) || 'there';
  const url = (unsubUrl && String(unsubUrl).trim()) || UNSUB_MAILTO;
  // Function replacers, so a "$&" or "$1" typed into a name is kept literally.
  const sub = (s, n, u) => String(s).replace(/\{\{firstName\}\}/g, () => n).replace(/\{\{unsubUrl\}\}/g, () => u);
  return {
    subject: sub(template.subject, name, url),
    text:    sub(template.text, name, url),
    html:    sub(template.html, escapeHtml(name), escapeHtml(url)),
  };
}

module.exports = { TEMPLATES, render, LIST_UNSUBSCRIBE, UNSUB_MAILTO, FROM, APP_URL };
