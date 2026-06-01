const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const pool     = require('../db/pool');
const { generateOTP, sendOTPEmail, sendWelcomeEmail, sendFounderSignupAlert } = require('../services/email');
const { signToken } = require('../middleware/auth');
const { signChallengeToken } = require('./twoFactor');
const analytics = require('../services/analytics');

// Rate limiters — TWO buckets per route: per-email (so a single victim
// can't be bombarded) AND per-IP (so a single attacker can't rotate
// emails to dodge the per-email limit). Both must pass.
//
// On a campus launch event, 30-50 students arrive from the same WiFi
// egress; the per-IP signup bucket is generous enough (20/hour) that
// legitimate launches still go through.
const sendLimitEmail = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max: 5,
  message: { error: 'Too many OTP requests for this email. Try again in 15 minutes.' },
  // Use the library's ipKeyGenerator helper for the IP fallback — it
  // collapses IPv6 addresses by /64 prefix so an attacker can't rotate
  // through trillions of IPv6 addresses to bypass the limit. The express-
  // rate-limit v8 validator warns when you use req.ip directly without it.
  keyGenerator: (req) =>
    (req.body?.email || '').toString().toLowerCase().trim() || ipKeyGenerator(req),
});

// Per-IP signup limiter — caps total signup attempts from one egress,
// regardless of how many email addresses are tried. Without this an
// attacker can rotate emails forever and the per-email limiter never
// fires.
const sendLimitIp = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 20,
  message: { error: 'Too many signups from this network. Try again in 1 hour.' },
  // Default keyGenerator (IP) is what we want here.
});

const verifyLimitEmail = rateLimit({
  windowMs: 10 * 60 * 1000,  // 10 min
  max: 5,
  message: { error: 'Too many verification attempts.' },
  keyGenerator: (req) =>
    (req.body?.email || '').toString().toLowerCase().trim() || ipKeyGenerator(req),
});

const verifyLimitIp = rateLimit({
  windowMs: 10 * 60 * 1000,  // 10 min
  max: 30,
  message: { error: 'Too many verification attempts from this network.' },
});

const refreshLimitIp = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many refresh attempts.' },
});

// ── POST /auth/send-code ──────────────────────────────────────────────────
// Validates .edu email, generates OTP, sends via SendGrid
router.post('/send-code', sendLimitIp, sendLimitEmail, async (req, res) => {
  try {
    // Guard against `req.body === undefined` (request with no Content-Type
    // and no body would otherwise throw on destructuring and bubble up to
    // a 500). Smoke test caught this — should be a clean 400.
    const { email, school, schoolDomain, schoolDomains } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const emailLower = email.trim().toLowerCase();

    // Returning-user fast path. If the email is already on file we don't
    // need school+schoolDomain in the payload — the school was captured at
    // signup and we trust it. Frontend signin mode sends `mode=signin`
    // without school params; this lookup is what makes that work without
    // forcing returning users back through the school picker every time
    // they sign in on a new device.
    const { rows: existingRows } = await pool.query(
      'SELECT school, school_domain FROM users WHERE email = $1 LIMIT 1',
      [emailLower]
    );
    const existingUser = existingRows[0];

    if (!existingUser && (!school || !schoolDomain)) {
      return res.status(400).json({
        error: 'school and schoolDomain are required for new signups',
      });
    }

    // Accept academic email addresses worldwide, not just US .edu. The
    // pattern covers the major country-academic TLD conventions:
    //   US           → *.edu
    //   UK / NZ / JP / KR / IN / ZA → *.ac.<cc>
    //   AU / SG / PH / MX / CN / IN / TR / etc. → *.edu.<cc>
    // Countries without a clean academic TLD (Canada .ca, Germany .de,
    // France .fr, Ireland .ie) get validated by exact match against the
    // school's pre-registered domain instead — see the schoolDomains
    // check below.
    const academicTldRegex = /\.(edu|edu\.[a-z]{2,3}|ac\.[a-z]{2,3})$/;

    const emailDomain  = emailLower.split('@')[1];
    // For existing users we use their on-file school_domain as the
    // accepted list when the client didn't send one. For new signups
    // the client always sends schoolDomain[s].
    const fallbackDomain = existingUser?.school_domain || schoolDomain || '';
    const acceptedList = Array.isArray(schoolDomains) && schoolDomains.length > 0
      ? schoolDomains.map(d => String(d).toLowerCase())
      : [String(fallbackDomain).toLowerCase()].filter(Boolean);
    const domainMatches = acceptedList.some(d => emailDomain === d || emailDomain.endsWith('.' + d));

    // Two acceptance paths:
    //   1. The email matches the school's pre-registered domain (handles
    //      every country including the no-academic-TLD ones, as long as
    //      the school is curated in the school list).
    //   2. The email has a recognized academic TLD pattern (handles
    //      international students whose school isn't yet curated — better
    //      than refusing them outright on day-one launch).
    const hasAcademicTld = academicTldRegex.test(emailDomain);
    if (!domainMatches && !hasAcademicTld) {
      const schoolLabel = school || existingUser?.school || 'your school';
      return res.status(400).json({
        error: `Email must be a verified school address (e.g. .edu, .ac.uk, .edu.au)${acceptedList.length ? ` or match ${acceptedList.join(' / ')} for ${schoolLabel}` : ''}`,
      });
    }

    // Invalidate any existing OTPs for this email
    await pool.query(
      'UPDATE otp_codes SET used = TRUE WHERE email = $1 AND used = FALSE',
      [emailLower]
    );

    const code      = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    await pool.query(
      'INSERT INTO otp_codes (email, code, expires_at) VALUES ($1, $2, $3)',
      [emailLower, code, expiresAt]
    );

    // Always log OTP so it's visible in Railway logs during testing
    console.log(`📧 OTP for ${emailLower}: ${code}`);

    // Send the email via Resend. We still return success even if Resend
    // throws (so the testing loop keeps moving — Railway logs print the
    // OTP code), but we surface the actual delivery status + error
    // message in the response so the frontend / a poking user can see
    // WHY no email arrived: missing RESEND_API_KEY, unverified domain,
    // free-tier quota exhausted, etc. Without this surface, "send-code"
    // claimed success but the inbox stayed empty with no diagnostic.
    let emailDelivery = 'sent';
    let emailError = null;
    try {
      await sendOTPEmail(emailLower, code);
    } catch (emailErr) {
      emailDelivery = 'failed';
      emailError    = emailErr?.message || 'Unknown Resend error';
      console.error('[/auth/send-code] Resend failure:', emailError);
    }

    res.json({
      success: true,
      message: emailDelivery === 'sent'
        ? `Code sent to ${emailLower}`
        : `Code generated but email delivery failed: ${emailError}`,
      emailDelivery,
      emailError,
    });
  } catch (err) {
    console.error('send-code error:', err);
    res.status(500).json({ error: 'Failed to send verification code' });
  }
});

// ── POST /auth/verify-code ────────────────────────────────────────────────
// Verifies OTP, creates/finds user, returns JWT
const MAX_OTP_ATTEMPTS = 5;
router.post('/verify-code', verifyLimitIp, verifyLimitEmail, async (req, res) => {
  try {
    const { email, code, school, schoolDomain } = req.body || {};

    if (!email || !code) {
      return res.status(400).json({ error: 'email and code are required' });
    }

    const emailLower = email.trim().toLowerCase();

    // Find valid OTP
    const { rows: otpRows } = await pool.query(
      `SELECT id, code, attempts FROM otp_codes
       WHERE email = $1 AND used = FALSE AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [emailLower]
    );

    if (!otpRows[0]) {
      return res.status(400).json({ error: 'Code expired or not found. Request a new code.' });
    }

    const otpRecord = otpRows[0];

    // Atomically increment + read the new attempt count. Without RETURNING
    // we compared the pre-increment value below and let the user have one
    // extra guess past the cap (the 4th wrong code was rejected, but the
    // 5th was allowed to validate before lockout fired).
    const { rows: bumped } = await pool.query(
      'UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts',
      [otpRecord.id]
    );
    const attemptsAfter = bumped[0]?.attempts ?? otpRecord.attempts + 1;

    if (attemptsAfter > MAX_OTP_ATTEMPTS) {
      await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = $1', [otpRecord.id]);
      return res.status(400).json({ error: 'Too many attempts. Request a new code.' });
    }

    if (otpRecord.code !== code.trim()) {
      // Once the user hits the cap with a wrong code, burn the OTP so the
      // next try can't re-validate even though the count check above
      // passed for THIS request.
      if (attemptsAfter >= MAX_OTP_ATTEMPTS) {
        await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = $1', [otpRecord.id]);
      }
      return res.status(400).json({ error: 'Incorrect code. Try again.' });
    }

    // Mark OTP used
    await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = $1', [otpRecord.id]);

    // Create or find user. Explicit column list (vs. SELECT *) so that
    // adding sensitive columns to users in the future doesn't accidentally
    // leak them through this auth response.
    let { rows: userRows } = await pool.query(
      `SELECT id, email, school, first_name, last_name,
              is_verified, trust_score, quiz_completed,
              identity_verified_at, totp_enabled
       FROM users WHERE email = $1`,
      [emailLower]
    );

    let user;
    let isNewUser = false;

    if (userRows[0]) {
      user = userRows[0];
    } else {
      const ins = await pool.query(
        `INSERT INTO users (email, school, school_domain, trust_score)
         VALUES ($1, $2, $3, 20)
         RETURNING id, email, school, first_name, last_name,
                   is_verified, trust_score, quiz_completed,
                   identity_verified_at, totp_enabled`,
        [emailLower, school || '', schoolDomain || '']
      );
      user      = ins.rows[0];
      isNewUser = true;

      // Fire-and-forget welcome email. The user has already moved past
      // this point in the UX (we return their token below) — they won't
      // wait on Resend. If it errors (Resend down, address bounces),
      // log it and move on; they got the OTP successfully so we know
      // the address works.
      sendWelcomeEmail(emailLower, user.id).catch(err => {
        console.error('[auth] welcome email failed:', err.message);
      });

      // Founder-side alert: every new signup pings llchaveniq@gmail.com
      // (or whichever ADMIN_ALERT_EMAIL is set) with the new user's row +
      // ready-to-paste SQL for approve/reject. Replaces the "founder
      // polls Railway daily" workflow with "founder eyeballs inbox."
      // Also fire-and-forget — never blocks signup if Resend hiccups.
      sendFounderSignupAlert({
        newUserId:    user.id,
        email:        emailLower,
        school:       user.school,
        firstName:    user.first_name,
        schoolDomain: schoolDomain || '',
      }).catch(err => {
        console.error('[auth] founder signup alert failed:', err.message);
      });

      // Server-side signup analytics — fires once, immediately after the
      // user row exists + JWT is about to be issued.
      const emailDomain = emailLower.split('@')[1] || null;
      analytics.track(analytics.EVENTS.signup_completed_server, user.id, {
        school: user.school,
        email_domain: emailDomain,
      });
      analytics.identify(user.id, {
        school: user.school,
        email_verified: false,
        signup_at: new Date().toISOString(),
      });
    }

    // Every successful verify-code is, by definition, an email verification.
    analytics.track(analytics.EVENTS.email_verified, user.id);
    analytics.identify(user.id, { email_verified: true });

    // 2FA gate. If the user has enrolled in TOTP, we stop here and return
    // a short-lived challenge token instead of the real session. The
    // frontend prompts for the 6-digit code (or a recovery code) and
    // POSTs to /auth/2fa/challenge to finish the login. Until that
    // succeeds the user has NO session — verifying just the OTP is no
    // longer enough.
    if (user.totp_enabled) {
      return res.json({
        requires2FA: true,
        twoFactorChallenge: signChallengeToken(user.id),
        // Echo a tiny bit of profile context so the 2FA prompt can show
        // "Signing in as juli@calpoly.edu" without another round trip.
        emailHint:  user.email,
      });
    }

    const token = signToken(user.id);

    res.json({
      success: true,
      token,
      userId:      user.id,
      isNewUser,
      quizCompleted: user.quiz_completed,
      profile: {
        id:          user.id,
        email:       user.email,
        school:      user.school,
        firstName:   user.first_name,
        lastName:    user.last_name,
        // Returning all profile-shape fields fixes the sign-in-blanks-the-
        // profile bug: previously the frontend received only first_name +
        // school and hardcoded "''" / 18 / { min: 500, max: 1500 } for the
        // rest, so signing in on a fresh device wiped the user's saved
        // bio, age, budget, move-in date, etc. They're all in the `users`
        // table — we just weren't sending them.
        lastInitial: user.last_name ? user.last_name.trim().charAt(0) : '',
        bio:         user.bio        ?? '',
        major:       user.major      ?? '',
        schoolYear:  user.school_year ?? '',
        age:         user.age        ?? null,
        gender:      user.gender     ?? '',
        lookingFor:  user.looking_for ?? [],
        photoUrl:    user.photo_url  ?? null,
        budgetMin:   user.budget_min ?? null,
        budgetMax:   user.budget_max ?? null,
        neighborhoods: user.neighborhoods ?? [],
        moveInDate:  user.move_in_date ?? null,
        isVerified:  user.is_verified,
        trustScore:  user.trust_score,
        quizCompleted: user.quiz_completed,
        // ID-verification timestamp (Stripe Identity). Null when the user
        // hasn't completed the selfie+ID flow; non-null = the "ID ✓"
        // trust badge shows on their match card.
        identityVerifiedAt: user.identity_verified_at,
        // 2FA state — surfaced for the Profile toggle. The user object
        // returned here is also written into authStore on sign-in, so
        // every screen that reads `user.totpEnabled` (the Privacy row
        // primarily) gets the live value without needing a follow-up
        // /users/me call.
        totpEnabled: user.totp_enabled === true,
      },
    });
  } catch (err) {
    console.error('verify-code error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ── POST /auth/refresh ────────────────────────────────────────────────────
// Refresh policy: a token may be exchanged for a fresh one if it is either
// still valid OR expired within the last REFRESH_GRACE_DAYS. Tokens older
// than that grace window are dead — the user must sign back in. Previously
// `ignoreExpiration: true` accepted tokens stolen years ago.
const REFRESH_GRACE_DAYS = 7;
router.post('/refresh', refreshLimitIp, async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required' });

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });

    // `exp` is seconds since epoch. If absent the token is malformed.
    const expSec = decoded.exp;
    if (typeof expSec !== 'number') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    const ageMs = Date.now() - expSec * 1000;
    if (ageMs > REFRESH_GRACE_DAYS * 86400 * 1000) {
      return res.status(401).json({ error: 'Token too old to refresh. Sign in again.' });
    }

    const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [decoded.userId]);
    if (!rows[0]) return res.status(401).json({ error: 'User not found' });

    res.json({ token: signToken(decoded.userId) });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;
