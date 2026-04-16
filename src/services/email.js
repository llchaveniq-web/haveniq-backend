const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Generate a 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send OTP verification email
async function sendOTPEmail(email, code, firstName = '') {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';

  const msg = {
    to:   email,
    from: { email: process.env.FROM_EMAIL, name: process.env.FROM_NAME || 'HavenIQ' },
    subject: `${code} is your HavenIQ verification code`,
    text: `${greeting}\n\nYour HavenIQ verification code is: ${code}\n\nThis code expires in 10 minutes. HavenIQ will never call or text you asking for this code.\n\n— The HavenIQ Team`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#F5FAFA; margin:0; padding:40px 20px;">
          <div style="max-width:480px; margin:0 auto; background:#fff; border-radius:20px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08);">

            <!-- Header -->
            <div style="background:#2CBFBE; padding:32px; text-align:center;">
              <p style="font-size:28px; font-weight:800; color:#fff; margin:0; letter-spacing:-0.5px;">HavenIQ ✦</p>
              <p style="color:rgba(255,255,255,0.85); margin:6px 0 0; font-size:14px;">Your perfect roommate match</p>
            </div>

            <!-- Body -->
            <div style="padding:40px 32px;">
              <p style="color:#2B2B3C; font-size:16px; margin:0 0 24px;">${greeting}</p>
              <p style="color:#6B7280; font-size:15px; line-height:1.6; margin:0 0 32px;">
                Use the code below to verify your .edu email and access your HavenIQ matches.
              </p>

              <!-- OTP box -->
              <div style="background:#F5FAFA; border:2px dashed #2CBFBE; border-radius:16px; padding:28px; text-align:center; margin-bottom:32px;">
                <p style="font-size:48px; font-weight:900; color:#2CBFBE; letter-spacing:12px; margin:0; font-variant-numeric:tabular-nums;">${code}</p>
              </div>

              <p style="color:#6B7280; font-size:13px; line-height:1.6; margin:0 0 8px;">
                ⏱ This code expires in <strong>10 minutes</strong>.
              </p>
              <p style="color:#6B7280; font-size:13px; line-height:1.6; margin:0;">
                🔒 HavenIQ will <strong>never</strong> call, text, or email you asking for this code.
              </p>
            </div>

            <!-- Footer -->
            <div style="background:#F5FAFA; padding:20px 32px; text-align:center; border-top:1px solid #E0EDED;">
              <p style="color:#6B7280; font-size:12px; margin:0;">
                You're receiving this because someone entered your .edu email on HavenIQ.
                If this wasn't you, ignore this email.
              </p>
            </div>
          </div>
        </body>
      </html>
    `,
  };

  await sgMail.send(msg);
}

// Send new match notification email
async function sendMatchEmail(toEmail, toName, matchName, score) {
  const msg = {
    to:   toEmail,
    from: { email: process.env.FROM_EMAIL, name: 'HavenIQ' },
    subject: `You have a new ${score}% match on HavenIQ ✦`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
        <h2 style="color:#2CBFBE;">Hi ${toName}! You have a new match ✦</h2>
        <p style="color:#6B7280;"><strong>${matchName}</strong> is <strong>${score}% compatible</strong> with you.</p>
        <p style="color:#6B7280;">Open HavenIQ to see their full profile and connect.</p>
        <a href="https://haveniq.com/app" style="display:inline-block;background:#2CBFBE;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:700;margin-top:16px;">
          See my match →
        </a>
      </div>
    `,
  };
  await sgMail.send(msg);
}

module.exports = { generateOTP, sendOTPEmail, sendMatchEmail };
