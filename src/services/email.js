const { Resend } = require('resend');
const analytics = require('./analytics');

// Lazy-initialize so the server doesn't crash if env var loads after module
function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

// Generate a 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
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
      html: `
        <!DOCTYPE html>
        <html>
          <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#F5FAFA; margin:0; padding:40px 20px;">
            <div style="max-width:480px; margin:0 auto; background:#fff; border-radius:20px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08);">
              <div style="background:#2CBFBE; padding:32px; text-align:center;">
                <p style="font-size:28px; font-weight:800; color:#fff; margin:0; letter-spacing:-0.5px;">HavenIQ ✦</p>
                <p style="color:rgba(255,255,255,0.85); margin:6px 0 0; font-size:14px;">Your perfect roommate match</p>
              </div>
              <div style="padding:40px 32px;">
                <p style="color:#2B2B3C; font-size:16px; margin:0 0 24px;">${greeting}</p>
                <p style="color:#6B7280; font-size:15px; line-height:1.6; margin:0 0 32px;">
                  Use the code below to verify your .edu email and access your HavenIQ matches.
                </p>
                <div style="background:#F5FAFA; border:2px dashed #2CBFBE; border-radius:16px; padding:28px; text-align:center; margin-bottom:32px;">
                  <p style="font-size:48px; font-weight:900; color:#2CBFBE; letter-spacing:12px; margin:0;">${code}</p>
                </div>
                <p style="color:#6B7280; font-size:13px; line-height:1.6; margin:0 0 8px;">⏱ This code expires in <strong>10 minutes</strong>.</p>
                <p style="color:#6B7280; font-size:13px; line-height:1.6; margin:0;">🔒 HavenIQ will <strong>never</strong> call, text, or email you asking for this code.</p>
              </div>
              <div style="background:#F5FAFA; padding:20px 32px; text-align:center; border-top:1px solid #E0EDED;">
                <p style="color:#6B7280; font-size:12px; margin:0;">
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
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
          <h2 style="color:#2CBFBE;">Hi ${toName}! You have a new match ✦</h2>
          <p style="color:#6B7280;"><strong>${matchName}</strong> is <strong>${score}% compatible</strong> with you.</p>
          <p style="color:#6B7280;">Open HavenIQ to see their full profile and connect.</p>
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
    await getResend().emails.send({
      from:    'HavenIQ <noreply@haveniq.org>',
      to:      parentEmail,
      subject: `${studentName} just matched with a verified roommate on HavenIQ ✦`,
    html: `
      <!DOCTYPE html>
      <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#F5FAFA; margin:0; padding:40px 20px;">
          <div style="max-width:520px; margin:0 auto; background:#fff; border-radius:20px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08);">
            <div style="background:#2CBFBE; padding:32px; text-align:center;">
              <p style="font-size:28px; font-weight:800; color:#fff; margin:0; letter-spacing:-0.5px;">HavenIQ ✦</p>
              <p style="color:rgba(255,255,255,0.85); margin:6px 0 0; font-size:14px;">Roommate matching for verified college students</p>
            </div>
            <div style="padding:36px 32px;">
              <p style="color:#2B2B3C; font-size:17px; margin:0 0 16px;">Hi there,</p>
              <p style="color:#2B2B3C; font-size:15px; line-height:1.6; margin:0 0 20px;">
                <strong>${studentName}</strong> shared your email when they signed up for HavenIQ so we could let you know about big milestones. Here's the first one:
              </p>
              <div style="background:#F5FAFA; border-left:4px solid #2CBFBE; padding:20px 24px; border-radius:8px; margin:0 0 24px;">
                <p style="font-size:18px; color:#2B2B3C; margin:0 0 6px; font-weight:600;">${studentName} just matched with ${matchName}.</p>
                <p style="font-size:14px; color:#6B7280; margin:0;">${compatibilityPct}% compatibility · ${matchSchool}</p>
              </div>
              <p style="color:#2B2B3C; font-size:14px; line-height:1.7; margin:0 0 18px;">
                <strong>Why we tell you:</strong> Roommate decisions are big. We want you in the loop — not by sharing ${studentName}'s private profile, but by letting you know that the person they matched with is:
              </p>
              <ul style="color:#2B2B3C; font-size:14px; line-height:1.8; padding-left:20px; margin:0 0 24px;">
                <li><strong>.edu verified</strong> — confirmed enrollment at ${matchSchool}</li>
                <li><strong>Quiz-matched</strong> — 55-question clinical compatibility framework, not just preferences</li>
                <li><strong>Anti-scam protected</strong> — contact info stays hidden until both sides ID-verify</li>
              </ul>
              <p style="color:#6B7280; font-size:13px; line-height:1.6; margin:0 0 8px;">
                We won't email you about every match — just the first one. If ${studentName} would rather we stopped, they can remove your email from Settings.
              </p>
            </div>
            <div style="background:#F5FAFA; padding:18px 32px; text-align:center; border-top:1px solid #E0EDED;">
              <p style="color:#6B7280; font-size:12px; margin:0;">HavenIQ · California-first roommate matching · haveniq.org</p>
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
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#F5FAFA; margin:0; padding:40px 20px;">
          <div style="max-width:520px; margin:0 auto; background:#fff; border-radius:20px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08);">
            <div style="background:#2CBFBE; padding:32px; text-align:center;">
              <p style="font-size:28px; font-weight:800; color:#fff; margin:0; letter-spacing:-0.5px;">HavenIQ ✦</p>
              <p style="color:rgba(255,255,255,0.85); margin:6px 0 0; font-size:14px;">Roommate matching for verified college students</p>
            </div>
            <div style="padding:36px 32px;">
              <p style="color:#2B2B3C; font-size:17px; margin:0 0 16px;">Hi there,</p>
              <p style="color:#2B2B3C; font-size:15px; line-height:1.7; margin:0 0 20px;">
                <strong>${name}</strong> added your email to their HavenIQ account so you can stay in the loop on their roommate search — one of the bigger decisions of the college year.
              </p>
              <div style="background:#F5FAFA; border-left:4px solid #2CBFBE; padding:18px 22px; border-radius:8px; margin:0 0 22px;">
                <p style="font-size:14px; color:#2B2B3C; margin:0 0 10px; font-weight:600;">What you'll get:</p>
                <p style="font-size:14px; color:#6B7280; line-height:1.7; margin:0;">
                  A heads-up at big milestones — like when ${name} connects with a roommate — including that the match is <strong>.edu&nbsp;verified</strong>. That's it. No spam.
                </p>
              </div>
              <p style="color:#2B2B3C; font-size:14px; line-height:1.7; margin:0 0 8px;"><strong>What we'll never share:</strong></p>
              <ul style="color:#6B7280; font-size:14px; line-height:1.8; padding-left:20px; margin:0 0 22px;">
                <li>${name}'s private messages</li>
                <li>Their match activity, preferences, or quiz answers</li>
              </ul>
              <p style="color:#6B7280; font-size:13px; line-height:1.6; margin:0;">
                ${name} stays in full control and can remove your email anytime from their Parent Dashboard.
              </p>
            </div>
            <div style="background:#F5FAFA; padding:18px 32px; text-align:center; border-top:1px solid #E0EDED;">
              <p style="color:#6B7280; font-size:12px; margin:0;">HavenIQ · roommate matching for verified college students · haveniq.org</p>
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
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#F5FAFA; margin:0; padding:40px 20px;">
          <div style="max-width:520px; margin:0 auto; background:#fff; border-radius:20px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08);">
            <div style="background:#2CBFBE; padding:36px; text-align:center;">
              <p style="font-size:32px; font-weight:800; color:#fff; margin:0; letter-spacing:-0.5px;">HavenIQ ✦</p>
              <p style="color:rgba(255,255,255,0.85); margin:6px 0 0; font-size:14px;">Roommate matching for verified college students</p>
            </div>
            <div style="padding:36px 32px;">
              <p style="color:#2B2B3C; font-size:18px; margin:0 0 18px; font-weight:600;">You're in. Welcome to HavenIQ.</p>
              <p style="color:#2B2B3C; font-size:15px; line-height:1.7; margin:0 0 22px;">
                Every account on HavenIQ has a verified academic email — including yours now. No catfishing, no scammers, no marketing bots. Just real students looking for the right person to live with.
              </p>

              <div style="background:#F5FAFA; border-left:4px solid #2CBFBE; padding:20px 24px; border-radius:8px; margin:0 0 24px;">
                <p style="font-size:15px; color:#2B2B3C; margin:0 0 12px; font-weight:600;">3 things to do this week:</p>
                <p style="font-size:14px; color:#6B7280; line-height:1.8; margin:0;">
                  <strong>1.</strong> Take the quiz — ~10 minutes, 55 questions, clinical-framework backed.<br/>
                  <strong>2.</strong> Add a photo + a 3-sentence bio (the AI writer screen helps).<br/>
                  <strong>3.</strong> Browse your matches and send your first connect request.
                </p>
              </div>

              <p style="color:#2B2B3C; font-size:14px; line-height:1.7; margin:0 0 18px;">
                <strong>One thing to know:</strong> the quiz isn't a personality test for fun — it's how we predict roommate compatibility from things like attachment style, conflict patterns, and sleep schedule. The more honestly you answer, the better the matches.
              </p>

              <p style="color:#6B7280; font-size:13px; line-height:1.7; margin:0 0 8px;">
                Questions? Hit us at <a href="mailto:support@haveniq.org" style="color:#2CBFBE; text-decoration:none;">support@haveniq.org</a>.
              </p>
              <p style="color:#6B7280; font-size:13px; line-height:1.7; margin:0;">
                See you in the matches feed.
              </p>
            </div>
            <div style="background:#F5FAFA; padding:18px 32px; text-align:center; border-top:1px solid #E0EDED;">
              <p style="color:#6B7280; font-size:12px; margin:0;">HavenIQ · roommate matching for verified college students · haveniq.org</p>
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
                <tr><td style="padding:6px 0; color:#6B7280; width:120px;">Report ID</td><td style="padding:6px 0; font-family:monospace;">${reportId}</td></tr>
                <tr><td style="padding:6px 0; color:#6B7280;">Category</td><td style="padding:6px 0;"><strong>${category}</strong></td></tr>
                <tr><td style="padding:6px 0; color:#6B7280;">Severity</td><td style="padding:6px 0;"><strong>${severity}</strong></td></tr>
                ${reason ? `<tr><td style="padding:6px 0; color:#6B7280;">Reason</td><td style="padding:6px 0;">${reason}</td></tr>` : ''}
                ${reporterId ? `<tr><td style="padding:6px 0; color:#6B7280;">Reporter</td><td style="padding:6px 0; font-family:monospace;">${reporterId}</td></tr>` : '<tr><td style="padding:6px 0; color:#6B7280;">Reporter</td><td style="padding:6px 0;"><em>anonymous</em></td></tr>'}
                ${reportedId ? `<tr><td style="padding:6px 0; color:#6B7280;">Reported user</td><td style="padding:6px 0; font-family:monospace;">${reportedId}</td></tr>` : ''}
              </table>
              ${details ? `
                <div style="margin-top:18px; padding:14px; background:#F9FAFB; border-radius:8px; border-left:3px solid #DC2626;">
                  <p style="margin:0 0 6px; font-size:12px; color:#6B7280; text-transform:uppercase; letter-spacing:0.5px;">Details</p>
                  <p style="margin:0; font-size:14px; color:#111827; line-height:1.6; white-space:pre-wrap;">${details}</p>
                </div>
              ` : ''}
              <p style="margin:18px 0 0; font-size:12px; color:#6B7280;">
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

module.exports = {
  generateOTP, sendOTPEmail, sendMatchEmail,
  sendParentMatchEmail, sendParentInviteEmail,
  sendWelcomeEmail, sendSafetyAlertEmail,
  sendFounderSignupAlert,
};
