const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const pool     = require('../db/pool');
const { generateOTP, sendOTPEmail } = require('../services/email');
const { signToken } = require('../middleware/auth');

// Rate limiters — keyed by EMAIL (not IP).
//
// Default express-rate-limit buckets by IP. On a campus launch event,
// all 30-50 students arrive from the same WiFi egress and would share
// the same bucket — the 6th OTP-request would block legitimate users.
// Keying by email instead means each student has their own quota and a
// campus-wide launch is safe.
//
// Falls back to IP when email is missing (e.g. on routes where the
// body is malformed) so the limiter still has SOME protection.
const sendLimit = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max: 5,
  message: { error: 'Too many OTP requests. Try again in 15 minutes.' },
  keyGenerator: (req) =>
    (req.body?.email || '').toString().toLowerCase().trim() || req.ip,
});

const verifyLimit = rateLimit({
  windowMs: 10 * 60 * 1000,  // 10 min
  max: 10,
  message: { error: 'Too many verification attempts.' },
  keyGenerator: (req) =>
    (req.body?.email || '').toString().toLowerCase().trim() || req.ip,
});

// ── POST /auth/send-code ──────────────────────────────────────────────────
// Validates .edu email, generates OTP, sends via SendGrid
router.post('/send-code', sendLimit, async (req, res) => {
  try {
    // Guard against `req.body === undefined` (request with no Content-Type
    // and no body would otherwise throw on destructuring and bubble up to
    // a 500). Smoke test caught this — should be a clean 400.
    const { email, school, schoolDomain, schoolDomains } = req.body || {};

    if (!email || !school || !schoolDomain) {
      return res.status(400).json({ error: 'email, school, and schoolDomain are required' });
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
    const emailLower = email.trim().toLowerCase();
    const academicTldRegex = /\.(edu|edu\.[a-z]{2,3}|ac\.[a-z]{2,3})$/;

    const emailDomain  = emailLower.split('@')[1];
    const acceptedList = Array.isArray(schoolDomains) && schoolDomains.length > 0
      ? schoolDomains.map(d => String(d).toLowerCase())
      : [String(schoolDomain).toLowerCase()];
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
      return res.status(400).json({
        error: `Email must be a verified school address (e.g. .edu, .ac.uk, .edu.au) or match ${acceptedList.join(' / ')} for ${school}`,
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

    // Try to send email but don't fail if it errors (e.g. Resend domain not verified yet)
    try {
      await sendOTPEmail(emailLower, code);
    } catch (emailErr) {
      console.error('Email send failed (check Railway logs for code):', emailErr.message);
    }

    res.json({ success: true, message: `Code sent to ${emailLower}` });
  } catch (err) {
    console.error('send-code error:', err);
    res.status(500).json({ error: 'Failed to send verification code' });
  }
});

// ── POST /auth/verify-code ────────────────────────────────────────────────
// Verifies OTP, creates/finds user, returns JWT
router.post('/verify-code', verifyLimit, async (req, res) => {
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

    // Track attempts
    await pool.query(
      'UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1',
      [otpRecord.id]
    );

    if (otpRecord.attempts >= 3) {
      await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = $1', [otpRecord.id]);
      return res.status(400).json({ error: 'Too many attempts. Request a new code.' });
    }

    if (otpRecord.code !== code.trim()) {
      return res.status(400).json({ error: 'Incorrect code. Try again.' });
    }

    // Mark OTP used
    await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = $1', [otpRecord.id]);

    // Create or find user. Explicit column list (vs. SELECT *) so that
    // adding sensitive columns to users in the future doesn't accidentally
    // leak them through this auth response.
    let { rows: userRows } = await pool.query(
      `SELECT id, email, school, first_name, last_name,
              is_verified, trust_score, quiz_completed
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
                   is_verified, trust_score, quiz_completed`,
        [emailLower, school || '', schoolDomain || '']
      );
      user      = ins.rows[0];
      isNewUser = true;
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
        isVerified:  user.is_verified,
        trustScore:  user.trust_score,
        quizCompleted: user.quiz_completed,
      },
    });
  } catch (err) {
    console.error('verify-code error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ── POST /auth/refresh ────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });

    const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [decoded.userId]);
    if (!rows[0]) return res.status(401).json({ error: 'User not found' });

    res.json({ token: signToken(decoded.userId) });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;
