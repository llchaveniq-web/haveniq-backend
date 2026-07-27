const { Resend } = require('resend');
const crypto = require('crypto');
const analytics = require('./analytics');

// Lazy-initialize so the server doesn't crash if env var loads after module
function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

// Single source of truth for escaping user-controlled text before it goes into
// email HTML. Full entity-encoding (incl. " and ') so a value is safe even if a
// future template moves it into an attribute — and it PRESERVES legit names
// ("Tom & Jerry" stays intact) rather than the older strip approach.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[<>&"']/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Generate a 6-digit OTP. Uses crypto.randomInt (CSPRNG), not Math.random
// — Math.random isn't suitable for security-relevant tokens because its
// stream is predictable from a small observed run. randomInt's upper
// bound is exclusive, so [100000, 1000000) yields a uniform 6-digit
// string with leading zeros preserved by .toString().
function generateOTP() {
  return crypto.randomInt(100000, 1000000).toString();
}

// Send OTP verification email. `userId` is optional because OTP fires before
// the user row exists; pass null in that case — PostHog will bucket under
// 'system'.
async function sendOTPEmail(email, code, firstName = '', userId = null) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';

  try {
    await getResend().emails.send({
      from: 'HavenIQ <noreply@haveniq.org>',
      to:      email,
      subject: `${code} is your HavenIQ verification code`,
      // Plain-text alternative — multipart emails land in the inbox far more
      // reliably than HTML-only, which .edu spam filters penalize. This is the
      // signup gate, so deliverability here gates the entire funnel.
      text: `${greeting}\n\nYour HavenIQ verification code is: ${code}\n\nUse it to verify your .edu email and access your matches. This code expires in 10 minutes.\n\nHavenIQ will never call, text, or email you asking for this code. If this wasn't you, just ignore this email.\n\nHavenIQ`,
      html: `
        <!DOCTYPE html>
        <html>
          <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#FBF1EA; margin:0; padding:40px 20px;">
            <div style="max-width:480px; margin:0 auto; background:#fff; border-radius:20px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08);">
              <div style="background:#A33625; padding:32px; text-align:center;">
                <p style="font-size:28px; font-weight:800; color:#fff; margin:0; letter-spacing:-0.5px;">HavenIQ ✦</p>
                <p style="color:rgba(255,255,255,0.85); margin:6px 0 0; font-size:14px;">Your perfect roommate match</p>
              </div>
              <div style="padding:40px 32px;">
                <p style="color:#2D2620; font-size:16px; margin:0 0 24px;">${greeting}</p>
                <p style="color:#75695A; font-size:15px; line-height:1.6; margin:0 0 32px;">
                  Use the code below to verify your .edu email and access your HavenIQ matches.
                </p>
                <div style="background:#FBF1EA; border:2px dashed #A33625; border-radius:16px; padding:28px; text-align:center; margin-bottom:32px;">
                  <p style="font-size:48px; font-weight:900; color:#A33625; letter-spacing:12px; margin:0;">${code}</p>
                </div>
                <p style="color:#75695A; font-size:13px; line-height:1.6; margin:0 0 8px;">⏱ This code expires in <strong>10 minutes</strong>.</p>
                <p style="color:#75695A; font-size:13px; line-height:1.6; margin:0;">🔒 HavenIQ will <strong>never</strong> call, text, or email you asking for this code.</p>
              </div>
              <div style="background:#FBF1EA; padding:20px 32px; text-align:center; border-top:1px solid #E8DCC6;">
                <p style="color:#75695A; font-size:12px; margin:0;">
                  You're receiving this because someone entered your .edu email on HavenIQ. If this wasn't you, ignore this email.
                </p>
              </div>
            </div>
          </body>
        </html>
      `,
    });
    analytics.track(analytics.EVENTS.email_sent, userId, { kind: 'otp' });
  } catch (err) {
    analytics.track(analytics.EVENTS.email_failed, userId, { kind: 'otp', error: err.message });
    throw err;
  }
}

// Send new match notification email
async function sendMatchEmail(toEmail, toName, matchName, score, userId = null) {
  try {
    await getResend().emails.send({
      from: 'HavenIQ <noreply@haveniq.org>',
      to:      toEmail,
      subject: `You have a new ${score}% match on HavenIQ ✦`,
      text: `Hi ${toName}! You have a new match on HavenIQ.\n\n${matchName} is ${score}% compatible with you. Open HavenIQ to see their full profile and connect.\n\nHavenIQ`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
          <h2 style="color:#A33625;">Hi ${toName}! You have a new match ✦</h2>
          <p style="color:#75695A;"><strong>${matchName}</strong> is <strong>${score}% compatible</strong> with you.</p>
          <p style="color:#75695A;">Open HavenIQ to see their full profile and connect.</p>
        </div>
      `,
    });
    analytics.track(analytics.EVENTS.email_sent, userId, { kind: 'match' });
  } catch (err) {
    analytics.track(analytics.EVENTS.email_failed, userId, { kind: 'match', error: err.message });
    throw err;
  }
}

// One-time "your student just matched" email to a student's parent the
// first time they accept a connect_request. Designed to convert parents
// from a veto-risk into an advocate — surfaces the .edu verification,
// the platform's anti-scam posture, and a link to the parent portal.
//
// `studentName`     — first name of the user whose parent we're emailing
// `matchName`       — first name + last initial of the matched roommate
// `matchSchool`     — school name (shared, since this is roommate-matching)
// `compatibilityPct` — the algorithm's score (0-100)
async function sendParentMatchEmail({ parentEmail, studentName, matchName, matchSchool, compatibilityPct, userId = null }) {
  try {
    // Omit the percentage entirely when we don't have one. The score comes from
    // a LEFT JOIN, so it can be null, and Number(null) is 0 — which used to tell
    // a parent their child matched at "0% compatibility". Saying less is the
    // honest option; stating a fabricated zero about someone's kid is not.
    const pctLine = Number.isFinite(Number(compatibilityPct)) && compatibilityPct !== null
      ? `${Math.round(Number(compatibilityPct))}% compatibility · ${matchSchool}`
      : `${matchSchool}`;
    await getResend().emails.send({
      from:    'HavenIQ <noreply@haveniq.org>',
      to:      parentEmail,
      subject: `${studentName} just matched with a verified roommate on HavenIQ ✦`,
    html: `
      <!DOCTYPE html>
      <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#FBF1EA; margin:0; padding:40px 20px;">
          <div style="max-width:520px; margin:0 auto; background:#fff; border-radius:20px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08);">
            <div style="background:#A33625; padding:32px; text-align:center;">
              <p style="font-size:28px; font-weight:800; color:#fff; margin:0; letter-spacing:-0.5px;">HavenIQ ✦</p>
              <p style="color:rgba(255,255,255,0.85); margin:6px 0 0; font-size:14px;">Roommate matching for verified college students</p>
            </div>
            <div style="padding:36px 32px;">
              <p style="color:#2D2620; font-size:17px; margin:0 0 16px;">Hi there,</p>
              <p style="color:#2D2620; font-size:15px; line-height:1.6; margin:0 0 20px;">
                <strong>${studentName}</strong> shared your email when they signed up for HavenIQ so we could let you know about big milestones. Here's the first one:
              </p>
              <div style="background:#FBF1EA; border-left:4px solid #A33625; padding:20px 24px; border-radius:8px; margin:0 0 24px;">
                <p style="font-size:18px; color:#2D2620; margin:0 0 6px; font-weight:600;">${studentName} just matched with ${matchName}.</p>
                <p style="font-size:14px; color:#75695A; margin:0;">${pctLine}</p>
              </div>
              <p style="color:#2D2620; font-size:14px; line-height:1.7; margin:0 0 18px;">
                <strong>Why we tell you:</strong> Roommate decisions are big. We want you in the loop, not by sharing ${studentName}'s private profile, but by letting you know that the person they matched with is:
              </p>
              <ul style="color:#2D2620; font-size:14px; line-height:1.8; padding-left:20px; margin:0 0 24px;">
                <li><strong>.edu verified:</strong> confirmed enrollment at ${matchSchool}</li>
                <li><strong>Quiz-matched:</strong> 17-question clinical compatibility framework, not just preferences</li>
                <li><strong>Anti-scam protected:</strong> contact details stay hidden until both students are .edu-verified and mutually agree to share them</li>
              </ul>
              <p style="color:#75695A; font-size:13px; line-height:1.6; margin:0 0 8px;">
                We won't email you about every match, just the first one. ${studentName} added your email and can remove it anytime in the HavenIQ app.
              </p>
            </div>
            <div style="background:#FBF1EA; padding:18px 32px; text-align:center; border-top:1px solid #E8DCC6;">
              <p style="color:#75695A; font-size:12px; margin:0;">HavenIQ · California-first roommate matching · haveniq.org</p>
            </div>
          </div>
        </body>
      </html>
    `,
    });
    analytics.track(analytics.EVENTS.email_sent, userId, { kind: 'parent_match' });
  } catch (err) {
    analytics.track(analytics.EVENTS.email_failed, userId, { kind: 'parent_match', error: err.message });
    throw err;
  }
}

// Warm intro email sent when a student invites a parent/guardian into the
// loop (Parent Dashboard → "Invite a parent"). Peace-of-mind only: it sets
// the expectation that the parent gets milestone heads-ups, NOT a live feed
// of the student's private activity.
//
// `parentEmail` — recipient
// `studentName` — first name of the student doing the inviting
async function sendParentInviteEmail({ parentEmail, studentName, userId = null }) {
  const name = studentName || 'Your student';
  try {
    await getResend().emails.send({
      from:    'HavenIQ <noreply@haveniq.org>',
      to:      parentEmail,
      subject: `${name} added you to their HavenIQ roommate search ✦`,
    html: `
      <!DOCTYPE html>
      <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#FBF1EA; margin:0; padding:40px 20px;">
          <div style="max-width:520px; margin:0 auto; background:#fff; border-radius:20px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08);">
            <div style="background:#A33625; padding:32px; text-align:center;">
              <p style="font-size:28px; font-weight:800; color:#fff; margin:0; letter-spacing:-0.5px;">HavenIQ ✦</p>
              <p style="color:rgba(255,255,255,0.85); margin:6px 0 0; font-size:14px;">Roommate matching for verified college students</p>
            </div>
            <div style="padding:36px 32px;">
              <p style="color:#2D2620; font-size:17px; margin:0 0 16px;">Hi there,</p>
              <p style="color:#2D2620; font-size:15px; line-height:1.7; margin:0 0 20px;">
                <strong>${name}</strong> added your email to their HavenIQ account so you can stay in the loop on their roommate search, one of the bigger decisions of the college year.
              </p>
              <div style="background:#FBF1EA; border-left:4px solid #A33625; padding:18px 22px; border-radius:8px; margin:0 0 22px;">
                <p style="font-size:14px; color:#2D2620; margin:0 0 10px; font-weight:600;">What you'll get:</p>
                <p style="font-size:14px; color:#75695A; line-height:1.7; margin:0;">
                  A heads-up at big milestones, like when ${name} connects with a roommate, including that the match is <strong>.edu&nbsp;verified</strong>. That's it. No spam.
                </p>
              </div>
              <p style="color:#2D2620; font-size:14px; line-height:1.7; margin:0 0 8px;"><strong>What we'll never share:</strong></p>
              <ul style="color:#75695A; font-size:14px; line-height:1.8; padding-left:20px; margin:0 0 22px;">
                <li>${name}'s private messages</li>
                <li>Their match activity, preferences, or quiz answers</li>
              </ul>
              <p style="color:#75695A; font-size:13px; line-height:1.6; margin:0;">
                ${name} added your email and can remove it anytime in the HavenIQ app.
              </p>
            </div>
            <div style="background:#FBF1EA; padding:18px 32px; text-align:center; border-top:1px solid #E8DCC6;">
              <p style="color:#75695A; font-size:12px; margin:0;">HavenIQ · roommate matching for verified college students · haveniq.org</p>
            </div>
          </div>
        </body>
      </html>
    `,
    });
    analytics.track(analytics.EVENTS.email_sent, userId, { kind: 'parent_invite' });
  } catch (err) {
    analytics.track(analytics.EVENTS.email_failed, userId, { kind: 'parent_invite', error: err.message });
    throw err;
  }
}

// Welcome email — fires once, after a brand-new user finishes signup
// (i.e. /auth/verify-code creates a fresh `users` row). Sets expectations
// for what happens next + surfaces the support inbox. Best-effort; if
// Resend is down or the user opted out of email later, we don't retry.
//
// `email` — verified academic address (what we just used to send the OTP)
async function sendWelcomeEmail(email, userId = null) {
  try {
    await getResend().emails.send({
      from:    'HavenIQ <noreply@haveniq.org>',
      to:      email,
      subject: `Welcome to HavenIQ ✦ Your first match is one quiz away`,
    html: `
      <!DOCTYPE html>
      <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#FBF1EA; margin:0; padding:40px 20px;">
          <div style="max-width:520px; margin:0 auto; background:#fff; border-radius:20px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08);">
            <div style="background:#A33625; padding:36px; text-align:center;">
              <p style="font-size:32px; font-weight:800; color:#fff; margin:0; letter-spacing:-0.5px;">HavenIQ ✦</p>
              <p style="color:rgba(255,255,255,0.85); margin:6px 0 0; font-size:14px;">Roommate matching for verified college students</p>
            </div>
            <div style="padding:36px 32px;">
              <p style="color:#2D2620; font-size:18px; margin:0 0 18px; font-weight:600;">You're in. Welcome to HavenIQ.</p>
              <p style="color:#2D2620; font-size:15px; line-height:1.7; margin:0 0 22px;">
                Every account on HavenIQ has a verified academic email, including yours now. No catfishing, no scammers, no marketing bots. Just real students looking for the right person to live with.
              </p>

              <div style="background:#FBF1EA; border-left:4px solid #A33625; padding:20px 24px; border-radius:8px; margin:0 0 24px;">
                <p style="font-size:15px; color:#2D2620; margin:0 0 12px; font-weight:600;">3 things to do this week:</p>
                <p style="font-size:14px; color:#75695A; line-height:1.8; margin:0;">
                  <strong>1.</strong> Take the quiz. ~3 minutes, 17 questions, clinical-framework backed.<br/>
                  <strong>2.</strong> Add a photo + a few real sentences on how you actually live. Specific beats generic.<br/>
                  <strong>3.</strong> Browse your matches and send your first connect request.
                </p>
              </div>

              <p style="color:#2D2620; font-size:14px; line-height:1.7; margin:0 0 18px;">
                <strong>One thing to know:</strong> the quiz isn't a personality test for fun. It's how we predict roommate compatibility from things like attachment style, conflict patterns, and sleep schedule. The more honestly you answer, the better the matches.
              </p>

              <p style="color:#75695A; font-size:13px; line-height:1.7; margin:0 0 8px;">
                Questions? Hit us at <a href="mailto:support@haveniq.org" style="color:#A33625; text-decoration:none;">support@haveniq.org</a>.
              </p>
              <p style="color:#75695A; font-size:13px; line-height:1.7; margin:0;">
                See you in the matches feed.
              </p>
            </div>
            <div style="background:#FBF1EA; padding:18px 32px; text-align:center; border-top:1px solid #E8DCC6;">
              <p style="color:#75695A; font-size:12px; margin:0;">HavenIQ · roommate matching for verified college students · haveniq.org</p>
            </div>
          </div>
        </body>
      </html>
    `,
    });
    analytics.track(analytics.EVENTS.email_sent, userId, { kind: 'welcome' });
  } catch (err) {
    analytics.track(analytics.EVENTS.email_failed, userId, { kind: 'welcome', error: err.message });
    throw err;
  }
}

// Safety alert email to the founder when a new user report comes in.
// Best-effort: we never want a Resend hiccup to break the report flow.
//
// Founder address resolution: env var SAFETY_ALERT_EMAIL wins, else falls
// back to support@haveniq.org which Cloudflare Email Routing forwards
// to the founder anyway.
async function sendSafetyAlertEmail({ reportId, category, severity, reason, details, reporterId, reportedId }) {
  const to = process.env.SAFETY_ALERT_EMAIL || 'support@haveniq.org';
  try {
    await getResend().emails.send({
      from:    'HavenIQ Safety <noreply@haveniq.org>',
      to,
      subject: `[${severity.toUpperCase()}] New report — ${category}${reportedId ? ` against user ${reportedId.slice(0, 8)}` : ''}`,
    html: `
      <!DOCTYPE html>
      <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#FAFAFA; margin:0; padding:24px 16px;">
          <div style="max-width:560px; margin:0 auto; background:#fff; border-radius:12px; overflow:hidden; border:1px solid #E5E7EB;">
            <div style="background:#DC2626; padding:18px 24px;">
              <p style="font-size:14px; font-weight:700; color:#fff; margin:0; letter-spacing:0.5px; text-transform:uppercase;">⚠ Safety alert — ${severity}</p>
            </div>
            <div style="padding:24px;">
              <table style="width:100%; font-size:14px; color:#111827; border-collapse:collapse;">
                <tr><td style="padding:6px 0; color:#75695A; width:120px;">Report ID</td><td style="padding:6px 0; font-family:monospace;">${reportId}</td></tr>
                <tr><td style="padding:6px 0; color:#75695A;">Category</td><td style="padding:6px 0;"><strong>${category}</strong></td></tr>
                <tr><td style="padding:6px 0; color:#75695A;">Severity</td><td style="padding:6px 0;"><strong>${severity}</strong></td></tr>
                ${reason ? `<tr><td style="padding:6px 0; color:#75695A;">Reason</td><td style="padding:6px 0;">${reason}</td></tr>` : ''}
                ${reporterId ? `<tr><td style="padding:6px 0; color:#75695A;">Reporter</td><td style="padding:6px 0; font-family:monospace;">${reporterId}</td></tr>` : '<tr><td style="padding:6px 0; color:#75695A;">Reporter</td><td style="padding:6px 0;"><em>anonymous</em></td></tr>'}
                ${reportedId ? `<tr><td style="padding:6px 0; color:#75695A;">Reported user</td><td style="padding:6px 0; font-family:monospace;">${reportedId}</td></tr>` : ''}
              </table>
              ${details ? `
                <div style="margin-top:18px; padding:14px; background:#F9FAFB; border-radius:8px; border-left:3px solid #DC2626;">
                  <p style="margin:0 0 6px; font-size:12px; color:#75695A; text-transform:uppercase; letter-spacing:0.5px;">Details</p>
                  <p style="margin:0; font-size:14px; color:#111827; line-height:1.6; white-space:pre-wrap;">${details}</p>
                </div>
              ` : ''}
              <p style="margin:18px 0 0; font-size:12px; color:#75695A;">
                Triage in Railway → user_reports table, or hit GET /admin/reports with founder auth.
              </p>
            </div>
          </div>
        </body>
      </html>
    `,
    });
    // No user context — safety alerts go to a fixed founder address.
    analytics.track(analytics.EVENTS.email_sent, null, { kind: 'safety_alert', report_id: reportId });
  } catch (err) {
    analytics.track(analytics.EVENTS.email_failed, null, { kind: 'safety_alert', error: err.message });
    throw err;
  }
}

// ─── Founder review alert ────────────────────────────────────────────────
//
// Fires once on every new user signup so the founder doesn't have to
// poll Railway for the review queue. Includes the user's full profile
// snapshot + ready-to-paste SQL for approve/reject, so the workflow is
// "open email → 30 sec eyeball → paste one SQL line." Sent to
// ADMIN_ALERT_EMAIL (defaults to llchaveniq@gmail.com — the catch-all
// from the Cloudflare email routing per project docs).
async function sendFounderSignupAlert({
  newUserId, email, school, firstName, schoolDomain,
}) {
  const adminEmail = process.env.ADMIN_ALERT_EMAIL || 'llchaveniq@gmail.com';
  const safeFirstName = firstName || '(no name yet)';
  const safeSchool    = school || '(no school yet)';

  try {
    await getResend().emails.send({
      from:    'HavenIQ Signups <noreply@haveniq.org>',
      to:      adminEmail,
      subject: `🎯 New HavenIQ signup: ${email}`,
      html: `
        <!DOCTYPE html>
        <html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; background:#F6EEDF; margin:0; padding:32px 16px;">
          <div style="max-width:560px; margin:0 auto; background:#fff; border-radius:16px; overflow:hidden;">
            <div style="padding:24px 28px; border-bottom:1px solid #E8DCC6;">
              <p style="margin:0; font-size:13px; color:#75695A; letter-spacing:0.6px; text-transform:uppercase; font-weight:600;">New signup · awaiting review</p>
              <p style="margin:6px 0 0; font-size:22px; font-weight:700; color:#2D2620;">${safeFirstName} · ${safeSchool}</p>
            </div>
            <div style="padding:24px 28px;">
              <p style="margin:0 0 16px; color:#2D2620; font-size:15px; line-height:1.6;">
                A new user just signed up. Eyeball the details, then paste one of the SQL lines below into Railway → Postgres → Query.
              </p>
              <table style="width:100%; border-collapse:collapse; margin-bottom:24px;">
                <tr><td style="padding:6px 0; color:#75695A; font-size:13px;">Email</td><td style="padding:6px 0; color:#2D2620; font-size:14px; font-weight:600;">${email}</td></tr>
                <tr><td style="padding:6px 0; color:#75695A; font-size:13px;">School</td><td style="padding:6px 0; color:#2D2620; font-size:14px;">${safeSchool}</td></tr>
                <tr><td style="padding:6px 0; color:#75695A; font-size:13px;">Domain</td><td style="padding:6px 0; color:#2D2620; font-size:14px;">${schoolDomain || '—'}</td></tr>
                <tr><td style="padding:6px 0; color:#75695A; font-size:13px;">User ID</td><td style="padding:6px 0; color:#75695A; font-size:12px; font-family:monospace;">${newUserId}</td></tr>
              </table>

              <p style="margin:0 0 8px; color:#75695A; font-size:12px; letter-spacing:0.6px; text-transform:uppercase; font-weight:600;">✅ Approve (paste into Railway)</p>
              <div style="background:#F1E6D2; border-radius:8px; padding:12px; margin-bottom:18px;">
                <code style="font-family: 'SF Mono', Menlo, monospace; font-size:12px; color:#2D2620; word-break:break-all;">UPDATE users SET is_verified = TRUE WHERE id = '${newUserId}';</code>
              </div>

              <p style="margin:0 0 8px; color:#75695A; font-size:12px; letter-spacing:0.6px; text-transform:uppercase; font-weight:600;">❌ Reject (paste into Railway)</p>
              <div style="background:#FAE5E5; border-radius:8px; padding:12px;">
                <code style="font-family: 'SF Mono', Menlo, monospace; font-size:12px; color:#2D2620; word-break:break-all;">UPDATE users SET is_banned = TRUE, ban_reason = 'failed manual review', banned_at = NOW() WHERE id = '${newUserId}';</code>
              </div>

              <p style="margin:24px 0 0; color:#75695A; font-size:12px; line-height:1.5;">
                Tip: come back in 24 hours and run<br>
                <code style="font-family:monospace; font-size:11px;">SELECT id, email, school, first_name, photo_url, bio FROM users WHERE is_verified = FALSE AND is_banned = FALSE AND created_at &gt; NOW() - INTERVAL '7 days' ORDER BY created_at DESC;</code><br>
                for a batch view of everyone pending.
              </p>
            </div>
          </div>
        </body></html>
      `,
    });
    analytics.track(analytics.EVENTS.email_sent, null, { kind: 'founder_signup_alert' });
  } catch (err) {
    // Never bubble — this is a nice-to-have, not blocking signup.
    console.error('[sendFounderSignupAlert] failed:', err.message);
    analytics.track(analytics.EVENTS.email_failed, null, { kind: 'founder_signup_alert', error: err.message });
  }
}

// ─── Weekly parent digest ────────────────────────────────────────────────
//
// Sent every Sunday (via an admin/cron endpoint) to every parent whose
// student has parent_email set + parent_notified=TRUE (i.e., the student
// has already opted-in via the first-match email flow). Summarizes the
// past week's activity: new matches, connections accepted, profile
// progress — but NEVER the names or photos of the people the student
// matched with (privacy gate; parents see their child's *engagement*,
// not the other students).
async function sendParentDigestEmail({
  parentEmail, studentFirstName,
  matchesThisWeek, connectionsThisWeek, conversationsActive,
  profilePctComplete, hasQuizCompleted, hasPhoto,
}) {
  if (!parentEmail) return;
  const safeStudent = studentFirstName || 'your student';
  const pct = Math.max(0, Math.min(100, Math.round(profilePctComplete || 0)));

  // Privacy-conscious copy: never says "Matched with Aisha." Says
  // "X new matches this week" so the parent sees engagement, not
  // identities of other students.
  try {
    await getResend().emails.send({
      from:    'HavenIQ <noreply@haveniq.org>',
      to:      parentEmail,
      subject: `${safeStudent}'s HavenIQ week`,
      html: `
        <!DOCTYPE html>
        <html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; background:#F6EEDF; margin:0; padding:32px 16px;">
          <div style="max-width:560px; margin:0 auto; background:#fff; border-radius:16px; overflow:hidden;">
            <div style="padding:32px 28px 16px; text-align:center;">
              <p style="margin:0; font-size:13px; color:#75695A; letter-spacing:0.8px; text-transform:uppercase; font-weight:600;">Weekly digest</p>
              <p style="margin:8px 0 0; font-size:24px; font-weight:700; color:#2D2620; font-family:'Fraunces', serif;">${safeStudent}'s HavenIQ week</p>
            </div>

            <div style="padding:16px 28px 8px;">
              <p style="margin:0 0 20px; color:#75695A; font-size:14px; line-height:1.6;">
                A short, private summary of how ${safeStudent}'s roommate search is going. We don't share match names or messages, only their activity. They control what they share with you directly.
              </p>

              <table style="width:100%; border-collapse:collapse; margin-bottom:20px;">
                <tr>
                  <td style="padding:14px; background:#F1E6D2; border-radius:12px 0 0 12px; text-align:center;">
                    <p style="margin:0; font-size:28px; font-weight:800; color:#A33625;">${matchesThisWeek}</p>
                    <p style="margin:4px 0 0; font-size:11px; color:#75695A; text-transform:uppercase; letter-spacing:0.5px;">New matches</p>
                  </td>
                  <td style="padding:14px; background:#F1E6D2; text-align:center; border-left:1px solid #E8DCC6; border-right:1px solid #E8DCC6;">
                    <p style="margin:0; font-size:28px; font-weight:800; color:#A33625;">${connectionsThisWeek}</p>
                    <p style="margin:4px 0 0; font-size:11px; color:#75695A; text-transform:uppercase; letter-spacing:0.5px;">Connected</p>
                  </td>
                  <td style="padding:14px; background:#F1E6D2; border-radius:0 12px 12px 0; text-align:center;">
                    <p style="margin:0; font-size:28px; font-weight:800; color:#A33625;">${conversationsActive}</p>
                    <p style="margin:4px 0 0; font-size:11px; color:#75695A; text-transform:uppercase; letter-spacing:0.5px;">Active chats</p>
                  </td>
                </tr>
              </table>

              <p style="margin:8px 0 6px; color:#2D2620; font-size:14px; font-weight:600;">Profile progress</p>
              <div style="background:#F1E6D2; border-radius:8px; height:8px; overflow:hidden; margin-bottom:8px;">
                <div style="background:#A33625; height:100%; width:${pct}%;"></div>
              </div>
              <p style="margin:0 0 16px; color:#75695A; font-size:12px;">
                ${pct}% complete · ${hasQuizCompleted ? 'Compatibility quiz ✓' : 'Quiz pending'} · ${hasPhoto ? 'Photo ✓' : 'No photo yet'}
              </p>

              <p style="margin:24px 0 8px; color:#2D2620; font-size:14px; line-height:1.6;">
                Want a deeper look or have questions? ${safeStudent} can show you the full app anytime — they have direct control over what's shared.
              </p>
            </div>

            <div style="padding:20px 28px; background:#F6EEDF; border-top:1px solid #E8DCC6;">
              <p style="margin:0; font-size:11px; color:#75695A; line-height:1.5; text-align:center;">
                You're receiving this because ${safeStudent} added your email as a parent contact on HavenIQ.
                <br>
                To stop these digests, ${safeStudent} can remove your email from their profile settings.
              </p>
            </div>
          </div>
        </body></html>
      `,
    });
    analytics.track(analytics.EVENTS.email_sent, null, { kind: 'parent_digest' });
  } catch (err) {
    console.error('[sendParentDigestEmail] failed:', err.message);
    analytics.track(analytics.EVENTS.email_failed, null, { kind: 'parent_digest', error: err.message });
  }
}

// Re-engagement email #2 — "someone wants to connect". Sent when a connect
// request is RECEIVED. On web (the whole production app) push tokens are never
// registered, so without this the recipient never learns someone reached out.
async function sendConnectRequestEmail(toEmail, toName, fromName, score, userId = null) {
  try {
    await getResend().emails.send({
      from: 'HavenIQ <noreply@haveniq.org>',
      to:      toEmail,
      subject: `${fromName} wants to connect on HavenIQ ✦`,
      text: `Hi ${toName} — ${fromName}${score ? ` (${score}% compatible)` : ''} wants to be your roommate on HavenIQ. Open HavenIQ to see their profile and accept or pass.\n\n— HavenIQ`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
          <h2 style="color:#a33625;">Hi ${toName} — someone wants to connect ✦</h2>
          <p style="color:#57423d;"><strong>${fromName}</strong>${score ? ` (${score}% compatible)` : ''} wants to be your roommate on HavenIQ.</p>
          <p style="color:#57423d;">Open HavenIQ to see their profile and accept or pass.</p>
        </div>
      `,
    });
    analytics.track(analytics.EVENTS.email_sent, userId, { kind: 'connect_request' });
  } catch (err) {
    analytics.track(analytics.EVENTS.email_failed, userId, { kind: 'connect_request', error: err.message });
    throw err;
  }
}

// Re-engagement email #3 — "you have a new message". Throttled by the caller
// to the FIRST unread message in a conversation (not per-message). Never
// includes the message body — a notification, not the content.
async function sendNewMessageEmail(toEmail, toName, fromName, userId = null) {
  try {
    await getResend().emails.send({
      from: 'HavenIQ <noreply@haveniq.org>',
      to:      toEmail,
      subject: `${fromName} sent you a message on HavenIQ`,
      text: `Hi ${toName} — ${fromName} just messaged you on HavenIQ. Open HavenIQ to read it and reply.\n\n— HavenIQ`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
          <h2 style="color:#a33625;">Hi ${toName} — you have a new message</h2>
          <p style="color:#57423d;"><strong>${fromName}</strong> just messaged you on HavenIQ.</p>
          <p style="color:#57423d;">Open HavenIQ to read it and reply.</p>
        </div>
      `,
    });
    analytics.track(analytics.EVENTS.email_sent, userId, { kind: 'new_message' });
  } catch (err) {
    analytics.track(analytics.EVENTS.email_failed, userId, { kind: 'new_message', error: err.message });
    throw err;
  }
}

// Support reply — a real human (founder/moderator) answering a "Report a
// problem" submission. Sent from support@ so the student can just reply and it
// lands back in the monitored inbox. Quotes what they wrote for context.
async function sendSupportReplyEmail({ toEmail, toName, replyBody, originalMessage }) {
  const safe = escapeHtml;
  await getResend().emails.send({
    from:     'HavenIQ Support <support@haveniq.org>',
    to:       toEmail,
    reply_to: 'support@haveniq.org',
    subject:  'Re: your message to HavenIQ support',
    html: `
      <!DOCTYPE html>
      <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#FBF1EA; margin:0; padding:40px 20px;">
          <div style="max-width:520px; margin:0 auto; background:#fff; border-radius:20px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08);">
            <div style="background:#A33625; padding:28px; text-align:center;">
              <p style="font-size:26px; font-weight:800; color:#fff; margin:0; letter-spacing:-0.5px;">HavenIQ ✦</p>
            </div>
            <div style="padding:32px;">
              <p style="color:#2D2620; font-size:16px; margin:0 0 16px;">Hi ${safe(toName) || 'there'},</p>
              <p style="color:#2D2620; font-size:15px; line-height:1.7; margin:0 0 22px; white-space:pre-wrap;">${safe(replyBody)}</p>
              ${originalMessage ? `<div style="background:#FBF1EA; border-left:4px solid #A33625; padding:14px 18px; border-radius:8px; margin:0 0 22px;">
                <p style="font-size:12px; color:#75695A; margin:0 0 6px; text-transform:uppercase; letter-spacing:0.5px;">You wrote:</p>
                <p style="font-size:14px; color:#75695A; line-height:1.6; margin:0; white-space:pre-wrap;">${safe(originalMessage).slice(0, 1000)}</p>
              </div>` : ''}
              <p style="color:#75695A; font-size:13px; line-height:1.6; margin:0;">Just reply to this email if you need anything else — it comes straight to us.</p>
            </div>
          </div>
        </body>
      </html>`,
  });
}

// Auto-acknowledgement — sent the instant a student submits "Report a problem",
// so they're never left wondering if it went through. Honest: promises a real
// person will reply, no fake SLA.
async function sendSupportAckEmail(toEmail, toName) {
  await getResend().emails.send({
    from:     'HavenIQ Support <support@haveniq.org>',
    to:       toEmail,
    reply_to: 'support@haveniq.org',
    subject:  'We got your message ✦',
    html: `
      <!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#FBF1EA;margin:0;padding:40px 20px;">
        <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
          <div style="background:#A33625;padding:28px;text-align:center;"><p style="font-size:26px;font-weight:800;color:#fff;margin:0;">HavenIQ ✦</p></div>
          <div style="padding:32px;">
            <p style="color:#2D2620;font-size:16px;margin:0 0 16px;">Hi ${escapeHtml(toName || 'there')},</p>
            <p style="color:#2D2620;font-size:15px;line-height:1.7;margin:0 0 18px;">Thanks for reaching out — we've got your message and a real person will get back to you. You can just reply to this email if you need to add anything.</p>
            <p style="color:#75695A;font-size:13px;line-height:1.6;margin:0;">If it's urgent or you feel unsafe, contact your campus safety office or call 911.</p>
          </div>
        </div>
      </body></html>`,
  });
}

// Crisis escalation — alerts the safety team when a student's message trips the
// self-harm/crisis detector, so a HUMAN can decide whether to reach out. The
// detector is a heuristic (false positives happen), so the copy says "may need
// support" and "use your judgment," not a diagnosis.
async function sendCrisisAlertEmail({ to, studentName, studentEmail, studentId, conversationId }) {
  const safe = (s) => escapeHtml(s) || '—';
  await getResend().emails.send({
    from:    'HavenIQ Safety <noreply@haveniq.org>',
    to,
    subject: '⚠️ Possible crisis signal — a student may need support',
    html: `
      <!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#1a1a1a;margin:0;padding:32px 20px;">
        <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;">
          <div style="background:#C0392B;padding:24px;"><p style="font-size:18px;font-weight:800;color:#fff;margin:0;">⚠️ Possible crisis signal</p></div>
          <div style="padding:28px;">
            <p style="color:#2D2620;font-size:15px;line-height:1.7;margin:0 0 16px;">A message from <strong>${safe(studentName)}</strong> (${safe(studentEmail)}) tripped the self-harm / crisis detector. Consider checking in — a short, human "hey, are you okay?" can matter.</p>
            <p style="color:#75695A;font-size:13px;line-height:1.6;margin:0 0 12px;">This is a heuristic detector, not a diagnosis — use your judgment. If you believe someone is in immediate danger, contact 911 or their campus safety office. The 988 Suicide &amp; Crisis Lifeline is available to share.</p>
            <p style="color:#75695A;font-size:12px;margin:0;">Student ID: ${safe(studentId)}${conversationId ? ` · Conversation: ${safe(conversationId)}` : ''}</p>
          </div>
        </div>
      </body></html>`,
  });
}

module.exports = {
  generateOTP, sendOTPEmail, sendMatchEmail,
  sendParentMatchEmail, sendParentInviteEmail,
  sendWelcomeEmail, sendSafetyAlertEmail,
  sendFounderSignupAlert,
  sendParentDigestEmail,
  sendConnectRequestEmail, sendNewMessageEmail,
  sendSupportReplyEmail, sendSupportAckEmail, sendCrisisAlertEmail,
};
