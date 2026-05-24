const { Resend } = require('resend');

// Lazy-initialize so the server doesn't crash if env var loads after module
function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

// Generate a 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send OTP verification email
async function sendOTPEmail(email, code, firstName = '') {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';

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
}

// Send new match notification email
async function sendMatchEmail(toEmail, toName, matchName, score) {
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
async function sendParentMatchEmail({ parentEmail, studentName, matchName, matchSchool, compatibilityPct }) {
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
}

// Warm intro email sent when a student invites a parent/guardian into the
// loop (Parent Dashboard → "Invite a parent"). Peace-of-mind only: it sets
// the expectation that the parent gets milestone heads-ups, NOT a live feed
// of the student's private activity.
//
// `parentEmail` — recipient
// `studentName` — first name of the student doing the inviting
async function sendParentInviteEmail({ parentEmail, studentName }) {
  const name = studentName || 'Your student';
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
}

// Welcome email — fires once, after a brand-new user finishes signup
// (i.e. /auth/verify-code creates a fresh `users` row). Sets expectations
// for what happens next + surfaces the support inbox. Best-effort; if
// Resend is down or the user opted out of email later, we don't retry.
//
// `email` — verified academic address (what we just used to send the OTP)
async function sendWelcomeEmail(email) {
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
}

module.exports = { generateOTP, sendOTPEmail, sendMatchEmail, sendParentMatchEmail, sendParentInviteEmail, sendWelcomeEmail };
