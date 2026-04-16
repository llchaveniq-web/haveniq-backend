const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const pool     = require('../db/pool');
const { generateOTP, sendOTPEmail } = require('../services/email');
const { signToken } = require('../middleware/auth');

// Rate limiters
const sendLimit = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max: 5,
  message: { error: 'Too many OTP requests. Try again in 15 minutes.' },
});

const verifyLimit = rateLimit({
  windowMs: 10 * 60 * 1000,  // 10 min
  max: 10,
  message: { error: 'Too many verification attempts.' },
});

// ── POST /auth/send-code ──────────────────────────────────────────────────
// Validates .edu email, generates OTP, sends via SendGrid
router.post('/send-code', sendLimit, async (req, res) => {
  try {
    const { email, school, schoolDomain } = req.body;

    if (!email || !school || !schoolDomain) {
      return res.status(400).json({ error: 'email, school, and schoolDomain are required' });
    }

    // Must be a .edu address
    const emailLower = email.trim().toLowerCase();
    if (!emailLower.endsWith('.edu')) {
      return res.status(400).json({ error: 'Only .edu email addresses are accepted' });
    }

    // Domain must match the selected school
    const emailDomain = emailLower.split('@')[1];
    if (emailDomain !== schoolDomain) {
      return res.status(400).json({
        error: `Email must be a ${schoolDomain} address for ${school}`,
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

    await sendOTPEmail(emailLower, code);

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
    const { email, code, school, schoolDomain } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'email and code are required' });
    }

    const emailLower = email.trim().toLowerCase();

    // Find valid OTP
    const { rows: otpRows } = await pool.query(
      `SELECT * FROM otp_codes
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

    // Create or find user
    let { rows: userRows } = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [emailLower]
    );

    let user;
    let isNewUser = false;

    if (userRows[0]) {
      user = userRows[0];
    } else {
      const ins = await pool.query(
        `INSERT INTO users (email, school, school_domain, trust_score)
         VALUES ($1, $2, $3, 20) RETURNING *`,
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
