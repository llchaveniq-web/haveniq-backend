const router = require('express').Router();
const rateLimit = require('../lib/rateLimit');
const { ipKeyGenerator } = require('../lib/rateLimit');
const crypto = require('crypto');
const pool     = require('../db/pool');
const { generateOTP, sendOTPEmail, sendWelcomeEmail, sendFounderSignupAlert } = require('../services/email');

// Record a successful sign-in for the user. Fire-and-forget — a DB
// failure here is loud but shouldn't break the auth response. The IP
// is coarse-binned to /24 (v4) or /48 (v6) so the audit log isn't a
// precise tracking record. User-agent is truncated to 256 chars.
function logSignIn(pool, userId, method, req) {
  const fullIp = req.ip || req.headers['x-forwarded-for'] || '';
  let ipPrefix = '';
  if (fullIp && fullIp.includes(':')) {
    // IPv6 — keep first three hextets (/48)
    ipPrefix = fullIp.split(':').slice(0, 3).join(':') + '::/48';
  } else if (fullIp) {
    // IPv4 — keep first three octets (/24)
    ipPrefix = fullIp.split('.').slice(0, 3).join('.') + '.0/24';
  }
  const ua = (req.headers['user-agent'] || '').toString().slice(0, 256);
  pool.query(
    'INSERT INTO sign_in_events (user_id, method, ip_prefix, user_agent) VALUES ($1,$2,$3,$4)',
    [userId, method, ipPrefix || null, ua || null],
  ).catch(err => console.error('[auth] logSignIn failed:', err.message));
}

// OTP hash + attempt cap are shared with the founder support endpoints
// (routes/admin.js resend/unlock) via lib/otp so they can never drift.
const { hashOtp, MAX_OTP_ATTEMPTS } = require('../lib/otp');
const { signToken, requireAuth } = require('../middleware/auth');
const { setSessionCookie, clearSessionCookie, readTokenCookie } = require('../lib/sessionCookie');
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

// Short-burst limiter — ~1 send / 30s PER EMAIL (the contract's anti-spam burst
// cap). Deliberately NOT per-IP: a campus-launch crowd shares one WiFi egress,
// so a 30s/IP cap would let one student's resend block the whole room. Stacked
// in front of the existing per-email (5/15min) and per-IP (20/hr) buckets.
const sendBurstLimit = rateLimit({
  windowMs: 30 * 1000,
  max: 1,
  message: { error: 'Please wait 30 seconds before requesting another code.' },
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

// /auth/verify-email is authed (the OTP is tied to req.user.email from the token,
// not the body), so key the limiter on the user id. A per-user cap alongside the
// per-code 3-attempt cap, matching the /verify-code posture (was relying only on
// the attempt cap + the global limiter).
const verifyEmailLimit = rateLimit({
  windowMs: 10 * 60 * 1000,  // 10 min
  max: 10,
  message: { error: 'Too many verification attempts.' },
  keyGenerator: (req) => (req.user?.id ? `uid:${req.user.id}` : ipKeyGenerator(req)),
});

const refreshLimitIp = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many refresh attempts.' },
});

// ── POST /auth/send-code ──────────────────────────────────────────────────
// Validates .edu email, generates OTP, sends via SendGrid
router.post('/send-code', sendBurstLimit, sendLimitIp, sendLimitEmail, async (req, res) => {
  try {
    // Guard against `req.body === undefined` (request with no Content-Type
    // and no body would otherwise throw on destructuring and bubble up to
    // a 500). Smoke test caught this — should be a clean 400.
    const { email, school, schoolDomain, schoolDomains } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const emailLower = email.trim().toLowerCase();

    // Pre-launch gate — block non-allowlisted emails from even getting an
    // OTP while HavenIQ is private. Founder + PRELAUNCH_ALLOWLIST only.
    {
      const { isAllowed, PRELAUNCH_MESSAGE } = require('../lib/launchGate');
      if (!isAllowed(emailLower)) {
        return res.status(403).json({ error: PRELAUNCH_MESSAGE, prelaunch: true });
      }
    }

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

    if (!existingUser) {
      // Signin mode = email only (no school params). Don't leak whether an
      // account exists: respond 200 as if a code was sent, but send nothing.
      // (A real account continues past this and gets emailed below.)
      if (!school && !schoolDomain) {
        return res.status(200).json({ ok: true });
      }
      // Signup with incomplete school info.
      if (!school || !schoolDomain) {
        return res.status(400).json({
          error: 'school and schoolDomain are required for new signups',
        });
      }
    }

    // Accept academic email addresses worldwide, not just US .edu. The
    // pattern enumerates REAL academic ccTLDs explicitly — the previous
    // version used `[a-z]{2,3}` which matched arbitrary 2-3 letter
    // suffixes, so foo.edu.com / foo.edu.net / foo.ac.io would slip
    // through. Bypass found by code-review pass 2026-06-02; closed now.
    //
    //   US           → *.edu
    //   UK / NZ / JP / KR / IN / ZA / IL → *.ac.<cc>
    //   AU / SG / PH / MX / CN / TR / IN / NG / PK → *.edu.<cc>
    //
    // If a real academic TLD is missing here, add it — don't widen the
    // regex back to a wildcard.
    const academicTldRegex = /\.(edu|edu\.(au|cn|mx|ph|sg|tr|in|ng|pk|hk|tw|my|id|br|co|pe|ar)|ac\.(uk|nz|jp|kr|in|za|il|th|ir|cn|ae))$/;

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

    // SECURITY — the .edu gate. Two checks, in order:
    //
    // (1) ALWAYS require a recognized academic TLD on the email itself.
    //     The previous version used `(!domainMatches && !hasAcademicTld)`
    //     which made the academic TLD optional when a schoolDomain was
    //     supplied — and `schoolDomain` is attacker-controllable. A
    //     request of `email: attacker@gmail.com, schoolDomain: gmail.com`
    //     would satisfy `domainMatches` and bypass the gate entirely.
    //     Probed and confirmed exploitable in prod 2026-06-02; closing
    //     now so non-student emails can't reach the OTP step.
    //
    //     The TLD pattern itself (.edu / .edu.<cc> / .ac.<cc>) is
    //     ICANN-controlled — you can't register `gmail.com.edu` so this
    //     is genuinely unforgeable from the request body.
    //
    // (2) If a specific school + schoolDomain was supplied at signup,
    //     the email's domain must also match it. Prevents claiming
    //     "Cal Poly" while signing up with a UCLA address — the
    //     identity-spoofing failure mode separate from the TLD gate.
    if (!hasAcademicTld) {
      return res.status(400).json({
        error: 'School email required (.edu, .ac.uk, .edu.au, …). HavenIQ is for verified students only — please use your school address.',
      });
    }

    // School-domain mismatch is NO LONGER a hard block.
    //
    // The academic-TLD gate above (hasAcademicTld) is the real .edu
    // boundary — ICANN-controlled and unforgeable from the request body —
    // and OTP-to-inbox proves the student actually controls the address.
    // Hard-rejecting when the email domain didn't match the picked
    // school's CURATED domain list turned away REAL students whenever that
    // list was incomplete: community-college district domains (e.g.
    // student.cccd.edu for Orange Coast College), school subdomains we
    // hadn't curated, brand-new schools, etc. Maintaining an exact domain
    // string for every school on earth is a losing game and every gap is a
    // locked-out student — so we stop blocking on it.
    //
    // We still log the mismatch so the curated domain list can be improved
    // over time, but a verified-student email is never refused for it.
    if (acceptedList.length > 0 && !domainMatches) {
      console.warn(
        `[send-code] domain/school mismatch (allowed): email-domain=${emailDomain} ` +
        `picked-school=${school || existingUser?.school || '?'} accepted=${acceptedList.join(',')}`,
      );
    }

    // Refuse to send OTPs to addresses Resend has flagged as
    // undeliverable. Without this we keep firing codes at dead
    // mailboxes, burning the per-email rate-limit budget for nothing.
    const { rows: badRows } = await pool.query(
      'SELECT email_undeliverable_reason FROM users WHERE LOWER(email) = $1 AND email_undeliverable = TRUE',
      [emailLower],
    );
    if (badRows[0]) {
      return res.status(400).json({
        error: 'This email looks undeliverable. Try a different .edu address, or email support@haveniq.org if you think this is wrong.',
        reason: badRows[0].email_undeliverable_reason,
      });
    }

    // Invalidate any existing OTPs for this email
    await pool.query(
      "UPDATE otp_codes SET used = TRUE WHERE email = $1 AND used = FALSE AND purpose = 'signup'",
      [emailLower]
    );

    const code      = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    // Store the hash, not the cleartext. /verify-code hashes the user's
    // submission the same way and compares. We keep the column named
    // `code` for backwards-compat with existing reads; future migration
    // can rename to code_hash.
    // Hashed storage with the cleartext-fallback verify in place. A DB
    // dump now exposes only sha256(code + JWT_SECRET) for in-flight
    // OTPs, not the cleartext code. The dual-path verify (further down)
    // accepts both formats so any OTP issued during the brief
    // cleartext window still validates.
    await pool.query(
      "INSERT INTO otp_codes (email, code, expires_at, purpose) VALUES ($1, $2, $3, 'signup')",
      [emailLower, hashOtp(code), expiresAt]
    );

    // Only log the cleartext OTP outside production, where Railway logs
    // are useful during dev. In prod the code never touches a log file.
    if (process.env.NODE_ENV !== 'production') {
      console.log(`📧 OTP for ${emailLower}: ${code}`);
    }

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
// Verifies OTP, creates/finds user, returns JWT.
//
// Attempt cap (MAX_OTP_ATTEMPTS, from lib/otp) is 3 — must stay in sync with
// verify.tsx's MAX_ATTEMPTS. Was 5, but the frontend locks the user out at 3
// wrong codes, so a scripted client that bypasses the React lockout was getting
// 5 guesses per code instead of the advertised 3. Either both sides agree or the
// limit isn't a limit.
router.post('/verify-code', verifyLimitIp, verifyLimitEmail, async (req, res) => {
  try {
    const { email, code, school, schoolDomain } = req.body || {};

    if (!email || !code) {
      return res.status(400).json({ error: 'email and code are required' });
    }

    const emailLower = email.trim().toLowerCase();

    // Pre-launch gate (backstop — /send-code already blocks, but guard here
    // too so a directly-crafted verify call can't slip through).
    {
      const { isAllowed, PRELAUNCH_MESSAGE } = require('../lib/launchGate');
      if (!isAllowed(emailLower)) {
        return res.status(403).json({ error: PRELAUNCH_MESSAGE, prelaunch: true });
      }
    }

    // Find valid OTP
    const { rows: otpRows } = await pool.query(
      `SELECT id, code, attempts FROM otp_codes
       WHERE email = $1 AND used = FALSE AND expires_at > NOW() AND purpose = 'signup'
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

    // Accept BOTH a cleartext stored OTP (current) and a sha256-hex
    // hashed stored OTP (from the brief hashed-storage window). The
    // dual-path verify keeps any in-flight OTP from before the
    // revert valid. constant-time comparison on the cleartext path
    // would matter at scale but 6-digit cleartext compare isn't a
    // meaningful timing leak; the hash path is constant-time via
    // timingSafeEqual.
    const submitted = code.trim();
    const stored    = otpRecord.code;
    let equal = false;
    if (stored === submitted) {
      equal = true;
    } else if (stored && stored.length === 64) {
      const submittedHash = hashOtp(submitted);
      equal = crypto.timingSafeEqual(
        Buffer.from(stored, 'hex'),
        Buffer.from(submittedHash, 'hex'),
      );
    }
    if (!equal) {
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
      // Returning user just re-passed .edu OTP — ensure they're verified
      // (covers accounts created before .edu auto-verify existed, so they
      // become matchable without a manual approval).
      if (!user.is_verified) {
        await pool.query('UPDATE users SET is_verified = TRUE WHERE id = $1', [user.id]);
        user.is_verified = true;
      }
    } else {
      // Store the user's ACTUAL verified email domain as school_domain
      // (not the picked school's curated domain). The email just passed
      // OTP verification, so this is the real, confirmed domain. It also
      // makes returning-user sign-in match cleanly: /send-code falls back
      // to the on-file school_domain as the accepted list, so a student on
      // a district domain (student.cccd.edu) won't trip the mismatch path
      // next time. The school NAME is still whatever they picked.
      const verifiedDomain = emailLower.split('@')[1] || schoolDomain || '';
      const ins = await pool.query(
        // is_verified = TRUE on creation: passing .edu OTP IS the
        // verification (the academic-email check at /send-code gates it),
        // so we don't need a manual human approval before the account can
        // appear in matches. Low-trust accounts still surface in the
        // auto-review for attention; they're just not blocked from existing.
        `INSERT INTO users (email, school, school_domain, trust_score, is_verified)
         VALUES ($1, $2, $3, 20, TRUE)
         RETURNING id, email, school, first_name, last_name,
                   is_verified, trust_score, quiz_completed,
                   identity_verified_at, totp_enabled`,
        [emailLower, school || '', verifiedDomain]
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
    // 2FA gate — re-enabled with diagnostic logging. The previous
    // failure that motivated the temporary disable was a stale
    // frontend route holding an old challenge token after the user's
    // totp_enabled had been cleared. The /auth/2fa/challenge fast-path
    // (issues session when totp_enabled is false) now catches that case
    // server-side, so a stale page can never trap a user again.
    //
    // The structured log records every gate decision with the inputs
    // that drove it. If a user ever reports "I shouldn't have 2FA but
    // it asked anyway," Sentry/Railway logs show exactly what the
    // backend saw at that moment.
    console.log(`[auth] 2FA gate decision for ${user.id}: totp_enabled=${user.totp_enabled === true}`);
    if (user.totp_enabled === true) {
      try {
        require('../utils/sentry').captureMessage?.(
          `2FA gate: requires2FA fired for ${user.id}`,
          'info',
        );
      } catch { /* sentry not loaded */ }
      return res.json({
        requires2FA: true,
        twoFactorChallenge: signChallengeToken(user.id),
        // Echo a tiny bit of profile context so the 2FA prompt can show
        // "Signing in as juli@calpoly.edu" without another round trip.
        emailHint:  user.email,
      });
    }

    const token = signToken(user.id);
    setSessionCookie(res, token);   // no-op until COOKIE_AUTH_ENABLED (staged migration)
    logSignIn(pool, user.id, 'otp', req);

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
    // Token from the request body (bearer clients) OR the httpOnly session
    // cookie (cookie-auth web sends an empty body). Either path re-issues the
    // token AND re-sets a fresh cookie, so a weekly-active cookie session never
    // expires out from under the user.
    const token = (req.body && req.body.token) || readTokenCookie(req);
    if (!token) return res.status(400).json({ error: 'token required' });

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true, algorithms: ['HS256'] });

    // SECURITY: reject typed tokens. A 2FA challenge JWT (purpose='2fa-challenge',
    // 5-min TTL, embedded userId) would otherwise round-trip through this endpoint
    // and mint a full 7-day session token — completely bypassing the TOTP step.
    // requireAuth() rejects challenge tokens on protected routes, but /refresh
    // is the one path that's allowed to consume an expired-or-expiring token,
    // and without this guard it would happily exchange a stolen challenge for
    // a session. Found by code-review pass 2026-06-02.
    if (decoded.purpose) {
      return res.status(401).json({ error: 'This token is not a session token.' });
    }

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

    logSignIn(pool, decoded.userId, 'refresh', req);
    const fresh = signToken(decoded.userId);
    setSessionCookie(res, fresh);   // no-op until COOKIE_AUTH_ENABLED (staged migration)
    res.json({ token: fresh });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ── POST /auth/logout ──────────────────────────────────────────────────────
// Clears the httpOnly session cookie — the ONLY way to end a cookie session,
// since client JS can't touch an httpOnly cookie. A no-op for bearer/native
// clients (they just drop their stored token). Always 200 so sign-out never
// "fails"; unauthenticated on purpose so a stale/expired session can still
// clear itself.
router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

// ── POST /auth/logout-all ──────────────────────────────────────────────────
// "Sign out everywhere." Stamps tokens_valid_after=NOW() so EVERY outstanding
// token for this user (including this one) is rejected by requireAuth from here
// on — the way to kill a stolen bearer token before its 7-day expiry. The user
// re-authenticates afterward. Requires a valid session to call (you can only
// nuke your OWN sessions).
router.post('/logout-all', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE users SET tokens_valid_after = NOW() WHERE id = $1', [req.user.id]);
    clearSessionCookie(res);
    res.json({ success: true });
  } catch (err) {
    console.error('[auth/logout-all] failed:', err.message);
    res.status(500).json({ error: 'Could not sign out all sessions' });
  }
});

// ═══ Logged-in .edu re-verification ════════════════════════════════════════
// Lets an already-signed-in student verify their school email and earn the
// is_verified badge. Acts ONLY on the token-derived user + their account .edu —
// never an email from the body (else a user could verify an address they don't
// own). Reuses the signup OTP machinery (otp_codes / generateOTP / hashOtp /
// sendOTPEmail / MAX_OTP_ATTEMPTS) with purpose='email_verification' so it's
// ONE code path, not a parallel one.

// Resend limiter: ~1 / 30s, keyed by the token user (no body email here).
// Mirrors the send-code limiter's intent for the authenticated case.
const resendVerifyLimit = rateLimit({
  windowMs: 30 * 1000,
  max: 1,
  message: { error: 'Please wait a moment before requesting another code.' },
  keyGenerator: (req) => (req.user?.id ? `uid:${req.user.id}` : ipKeyGenerator(req)),
});

// ── POST /auth/resend-verification (auth; no body) ─────────────────────────
router.post('/resend-verification', requireAuth, resendVerifyLimit, async (req, res) => {
  try {
    const userId = req.user.id;
    const email  = (req.user.email || '').toLowerCase().trim();

    if (!/\.edu$/i.test(email)) {
      return res.status(400).json({ error: 'Your account email is not a .edu address.' });
    }

    const { rows } = await pool.query('SELECT is_verified FROM users WHERE id = $1', [userId]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    if (rows[0].is_verified) return res.status(200).json({ ok: true, alreadyVerified: true });

    // Invalidate any prior, still-unused verification codes for this user so
    // only the newest is live. Scoped to purpose so it never touches a signup code.
    await pool.query(
      `UPDATE otp_codes SET used = TRUE
        WHERE email = $1 AND purpose = 'email_verification' AND used = FALSE`,
      [email]
    );

    const code      = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min
    await pool.query(
      `INSERT INTO otp_codes (email, code, expires_at, purpose)
       VALUES ($1, $2, $3, 'email_verification')`,
      [email, hashOtp(code), expiresAt]
    );

    if (process.env.NODE_ENV !== 'production') console.log(`📧 re-verify OTP for ${email}: ${code}`);

    // Best-effort send (same posture as /send-code — never block on Resend).
    try { await sendOTPEmail(email, code, req.user.first_name || ''); }
    catch (e) { console.error('[resend-verification] email send failed:', e?.message); }

    return res.json({ ok: true });
  } catch (err) {
    console.error('resend-verification error:', err);
    return res.status(500).json({ error: 'Failed to send verification code.' });
  }
});

// ── POST /auth/verify-email (auth; body: { code }) ─────────────────────────
// The ONLY place is_verified may be set to true post-signup.
router.post('/verify-email', requireAuth, verifyEmailLimit, async (req, res) => {
  try {
    const userId = req.user.id;
    const email  = (req.user.email || '').toLowerCase().trim();
    const code   = (req.body?.code ?? '').toString().trim();
    if (!code) return res.status(400).json({ error: 'Code required.' });

    const { rows: otpRows } = await pool.query(
      `SELECT id, code, attempts FROM otp_codes
        WHERE email = $1 AND purpose = 'email_verification' AND used = FALSE AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT 1`,
      [email]
    );
    // Missing / expired → 4xx (NOT 5xx) so the app shows "incorrect or expired".
    if (!otpRows[0]) {
      return res.status(400).json({ error: 'That code is incorrect or expired. Request a new one.' });
    }
    const rec = otpRows[0];

    // Brute-force guard: atomically bump + cap attempts (mirrors /verify-code).
    const { rows: bumped } = await pool.query(
      'UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts',
      [rec.id]
    );
    if ((bumped[0]?.attempts ?? rec.attempts + 1) > MAX_OTP_ATTEMPTS) {
      await pool.query('DELETE FROM otp_codes WHERE id = $1', [rec.id]);
      return res.status(400).json({ error: 'Too many attempts. Request a new code.' });
    }

    // Hashed compare (cleartext fallback for parity with /verify-code).
    const stored = rec.code;
    let equal = false;
    if (stored === code) {
      equal = true;
    } else if (stored && stored.length === 64) {
      equal = crypto.timingSafeEqual(
        Buffer.from(stored, 'hex'),
        Buffer.from(hashOtp(code), 'hex'),
      );
    }
    if (!equal) {
      return res.status(400).json({ error: 'That code is incorrect or expired. Request a new one.' });
    }

    // Valid → grant the badge, then delete the code (single-use).
    await pool.query('UPDATE users SET is_verified = TRUE WHERE id = $1', [userId]);
    await pool.query('DELETE FROM otp_codes WHERE id = $1', [rec.id]);

    return res.json({ ok: true, isVerified: true });
  } catch (err) {
    console.error('verify-email error:', err);
    return res.status(500).json({ error: 'Verification failed.' });
  }
});

// ── GET /auth/me (auth) ────────────────────────────────────────────────────
// Current user for the app to refetch after verifying. `isVerified` is the
// field the frontend reads.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, school, is_verified, trust_score, quiz_completed
         FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    const u = rows[0];
    return res.json({
      id:            u.id,
      email:         u.email,
      school:        u.school,
      isVerified:    u.is_verified,
      trustScore:    u.trust_score,
      quizCompleted: u.quiz_completed,
    });
  } catch (err) {
    console.error('auth/me error:', err);
    return res.status(500).json({ error: 'Failed to load user.' });
  }
});

module.exports = router;
