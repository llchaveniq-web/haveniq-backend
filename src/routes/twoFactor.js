/**
 * Two-Factor Authentication (TOTP) routes.
 *
 * Backs the Profile → Privacy & Security → Two-Factor Auth row, which
 * previously routed to a UI mockup with no backend. This file replaces
 * that gap with real account security:
 *
 *   POST /auth/2fa/setup           (auth required)
 *     Begin enrollment. Generates a fresh TOTP secret + 10 single-use
 *     recovery codes. The plaintext secret and codes are returned to the
 *     user EXACTLY ONCE so they can save them in their authenticator app
 *     + somewhere offline. The DB row is updated with the secret (clear)
 *     and the bcrypt hashes of each recovery code. totp_enabled stays
 *     FALSE until the user proves they can read codes off their device.
 *
 *   POST /auth/2fa/verify-setup    (auth required)
 *     Finish enrollment. Accepts a TOTP code from the user's authenticator
 *     app. If it validates against the stored secret, flips
 *     totp_enabled = TRUE and the user is now protected on every future
 *     sign-in.
 *
 *   POST /auth/2fa/disable         (auth required)
 *     Turn off 2FA. Requires a fresh TOTP code (or one unused recovery
 *     code) so a stolen session can't quietly remove the second factor.
 *     Clears the secret and recovery codes — the user must re-enroll
 *     from scratch if they want it back on.
 *
 *   POST /auth/2fa/challenge       (NOT auth required — pre-session)
 *     Login second factor. After /auth/verify-code succeeds, if the user
 *     has 2FA enabled the response is `{ requires2FA: true,
 *     twoFactorChallenge: <short-lived JWT> }`. The frontend posts that
 *     challenge token + the user's TOTP code (or one recovery code) here;
 *     on success we issue the real long-lived session token + profile.
 *
 * Design choices worth flagging:
 *
 *   • otplib runs entirely in-process, no external service. No SMS
 *     provider cost, no Twilio dependency, no privacy leak from putting
 *     phone numbers in a third party. TOTP is the same protocol Google
 *     Authenticator / 1Password / Authy / Bitwarden all read.
 *
 *   • Recovery codes are stored as bcrypt hashes (not raw or
 *     reversibly encrypted). A DB leak can't reveal them. Each code can
 *     be used exactly once — verifying a code removes its hash from
 *     totp_recovery_codes. When the array empties, "I lost my phone"
 *     becomes a support request, by design.
 *
 *   • Setup is two-step (write secret → user verifies → enable). This
 *     stops the failure mode where the user clicks "Set up", closes the
 *     screen before scanning the code, and is now locked out of the
 *     site on their next login because totp_enabled was prematurely
 *     true with no working authenticator on the other side.
 *
 *   • The challenge token is a separate short-lived JWT with a
 *     `purpose: '2fa-challenge'` claim and a 5-minute TTL. Even if it
 *     leaks, it can't be used as a normal session token because every
 *     authed endpoint verifies the absence of that claim implicitly
 *     (signToken issues `{ userId }`, no purpose). And it expires
 *     before any reasonable attacker timeline.
 */

const router  = require('express').Router();
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { authenticator } = require('otplib');
const pool    = require('../db/pool');
const { requireAuth, signToken } = require('../middleware/auth');
const { setSessionCookie } = require('../lib/sessionCookie');

// ── Rate limiters ────────────────────────────────────────────────────
// Without these the 2FA routes are a brute-force surface:
//   • /challenge — 6-digit TOTP has 1M combinations. authenticator.check
//     with window:1 accepts the prev/current/next step, so any given
//     moment 3 codes work — ~333K guesses to hit. Global IP limiter
//     (200/15min) is not nearly tight enough.
//   • /verify-setup — similar. Adds friction to enrollment but the
//     legitimate user only needs one or two tries.
//   • /disable — would let an attacker with a stolen session grind
//     past the second-factor confirmation.
//   • /setup — relatively cheap, but each call generates 10 bcrypt
//     hashes (~1s CPU). Limit prevents cheap CPU DoS.
//
// Keyed by `email-or-userId` when available so a single attacker who
// rotates IPs still gets caught. Falls back to IP for the pre-session
// /challenge calls. Skips successful requests so a user fumbling one
// digit doesn't burn their whole budget.
const setupLimit = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 6,
  message: { error: 'Too many setup attempts. Try again in an hour.' },
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req),
});
const verifySetupLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many verification attempts.' },
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req),
  skipSuccessfulRequests: true,
});
const disableLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many disable attempts.' },
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req),
  skipSuccessfulRequests: true,
});
// Challenge is pre-session — no req.user. Best key is the challenge JWT
// itself (one-attacker-per-challenge), with IP as the ultimate fallback.
const challengeLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many code attempts. Sign in again to get a fresh challenge.' },
  keyGenerator: (req) => {
    const t = (req.body?.challenge || '').slice(0, 96);
    return t || ipKeyGenerator(req);
  },
  skipSuccessfulRequests: true,
});

// Same TOTP options Google Authenticator, 1Password and Authy default to.
// Window: 1 step (30s) of tolerance on either side of "now" lets a slow
// typer or a slightly-clock-skewed phone still validate.
authenticator.options = { window: 1, step: 30 };

const APP_NAME = 'HavenIQ';

// ── Recovery code helpers ────────────────────────────────────────────
//
// Two correctness properties matter here:
//
//   1. Atomicity. Two parallel requests with the same valid recovery
//      code must not both succeed. The naive read → bcrypt-match →
//      write sequence has a window in which both requests see the
//      same array, both pass bcrypt, both UPDATE — and now the same
//      code authenticated twice. Closed below with SELECT … FOR
//      UPDATE inside a transaction that holds the row lock until
//      the UPDATE commits.
//
//   2. Timing stability. A short-circuiting bcrypt loop reveals the
//      number of remaining codes (and partially, which slot the user
//      hit). Closed below by always iterating every slot — even
//      after a match — so the wall-clock time for "wrong code with
//      10 hashes present" is indistinguishable from "right code,
//      hit on slot 0 with 10 hashes present."
//
// Returns { matched, indexHint } where indexHint is the consumed slot
// (or -1 if no match). The consumption is committed by the time the
// promise resolves with matched=true; callers don't need to do a
// follow-up UPDATE.
async function consumeRecoveryCodeAtomic(userId, recoveryCode) {
  const code = String(recoveryCode).trim();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT totp_recovery_codes FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );
    const hashes = rows[0]?.totp_recovery_codes || [];

    // Constant-time match: bcrypt every hash even after a hit. The
    // attacker observing wall-clock time can't tell whether the match
    // happened on slot 0, slot 9, or never.
    let matchIndex = -1;
    for (let i = 0; i < hashes.length; i++) {
      const equal = await bcrypt.compare(code, hashes[i]);
      if (equal && matchIndex === -1) matchIndex = i;
    }

    if (matchIndex === -1) {
      await client.query('COMMIT');
      return { matched: false, indexHint: -1 };
    }

    const remaining = hashes.filter((_, i) => i !== matchIndex);
    await client.query(
      'UPDATE users SET totp_recovery_codes = $1 WHERE id = $2',
      [remaining, userId],
    );
    await client.query('COMMIT');
    return { matched: true, indexHint: matchIndex };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

const CHALLENGE_TTL_SECONDS = 5 * 60;
const CHALLENGE_PURPOSE     = '2fa-challenge';

const RECOVERY_CODE_COUNT  = 10;
const RECOVERY_CODE_BYTES  = 5;   // → 10 hex chars per code, e.g. "a1b2-c3d4-e5"
const RECOVERY_CODE_BCRYPT_ROUNDS = 10;

// Generate one human-friendly recovery code. 10 hex characters in three
// hyphen-separated groups so they're readable when written on paper.
function generateRecoveryCode() {
  const hex = crypto.randomBytes(RECOVERY_CODE_BYTES).toString('hex'); // 10 chars
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 10)}`;
}

// Compact, copy-paste-friendly TOTP secret. otplib's generator returns a
// fresh base32 string suitable for the otpauth:// URL.
function generateSecret() {
  return authenticator.generateSecret();
}

// Constructs the standard otpauth:// URL the authenticator app understands.
// Wrapping with otplib's keyuri pins the issuer/account format every
// vendor app expects.
function otpauthUrl(email, secret) {
  return authenticator.keyuri(email, APP_NAME, secret);
}

// ── POST /auth/2fa/setup ─────────────────────────────────────────────
router.post('/setup', requireAuth, setupLimit, async (req, res) => {
  try {
    const userId = req.user.id;

    // Block re-enrollment while 2FA is already on. Forces the user
    // through /disable first, which itself requires a working code —
    // so a stolen session can't replace someone's authenticator behind
    // their back.
    const { rows: existing } = await pool.query(
      'SELECT totp_enabled FROM users WHERE id = $1',
      [userId],
    );
    if (existing[0]?.totp_enabled) {
      return res.status(409).json({
        error: '2FA is already enabled. Disable it first to set up a new authenticator.',
      });
    }

    const secret = generateSecret();
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    const recoveryHashes = await Promise.all(
      recoveryCodes.map(c => bcrypt.hash(c, RECOVERY_CODE_BCRYPT_ROUNDS)),
    );

    await pool.query(
      `UPDATE users
          SET totp_secret = $1,
              totp_recovery_codes = $2,
              totp_enabled = FALSE
        WHERE id = $3`,
      [secret, recoveryHashes, userId],
    );

    const url = otpauthUrl(req.user.email, secret);

    return res.json({
      // The bare secret is shown to the user as a fallback for app
      // setups that don't scan QR codes (or web users without a camera).
      secret,
      otpauthUrl: url,
      // ONE-TIME exposure of plaintext recovery codes. The DB only has
      // the hashes from here on. If the user closes this screen without
      // saving them, they're gone — they'll have to use /disable then
      // /setup to get a fresh set.
      recoveryCodes,
    });
  } catch (err) {
    console.error('[2fa] /setup error:', err);
    res.status(500).json({ error: '2FA setup failed' });
  }
});

// ── POST /auth/2fa/verify-setup ──────────────────────────────────────
router.post('/verify-setup', requireAuth, verifySetupLimit, async (req, res) => {
  try {
    const userId = req.user.id;
    const { code } = req.body || {};
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'code is required' });
    }

    const { rows } = await pool.query(
      'SELECT totp_secret, totp_enabled FROM users WHERE id = $1',
      [userId],
    );
    const row = rows[0];
    if (!row?.totp_secret) {
      return res.status(400).json({ error: 'Call /setup first.' });
    }
    if (row.totp_enabled) {
      return res.status(409).json({ error: '2FA is already enabled.' });
    }

    const ok = authenticator.check(code.trim(), row.totp_secret);
    if (!ok) {
      return res.status(400).json({ error: 'Incorrect code. Check the app and try the current 6 digits.' });
    }

    await pool.query('UPDATE users SET totp_enabled = TRUE WHERE id = $1', [userId]);

    return res.json({ enabled: true });
  } catch (err) {
    console.error('[2fa] /verify-setup error:', err);
    res.status(500).json({ error: '2FA verification failed' });
  }
});

// ── POST /auth/2fa/disable ───────────────────────────────────────────
router.post('/disable', requireAuth, disableLimit, async (req, res) => {
  try {
    const userId = req.user.id;
    const { code, recoveryCode } = req.body || {};
    if (!code && !recoveryCode) {
      return res.status(400).json({ error: 'code or recoveryCode is required' });
    }

    const { rows } = await pool.query(
      'SELECT totp_secret, totp_enabled, totp_recovery_codes FROM users WHERE id = $1',
      [userId],
    );
    const row = rows[0];
    if (!row?.totp_enabled || !row.totp_secret) {
      return res.status(400).json({ error: '2FA is not currently enabled.' });
    }

    let authorized = false;
    let viaRecovery = false;

    if (code) {
      authorized = authenticator.check(String(code).trim(), row.totp_secret);
    }
    if (!authorized && recoveryCode) {
      // Atomic + constant-time (see consumeRecoveryCodeAtomic). The
      // helper has already committed the consumption when matched
      // is true, so we don't need to follow up with another UPDATE
      // to remove the used hash — the /disable UPDATE below also
      // clears the array.
      const result = await consumeRecoveryCodeAtomic(userId, recoveryCode);
      authorized = result.matched;
      viaRecovery = result.matched;
    }
    if (!authorized) {
      return res.status(400).json({ error: 'Incorrect code.' });
    }

    // Clear the secret + recovery codes. The user must run /setup again
    // for a brand new secret + codes if they want 2FA back on.
    await pool.query(
      `UPDATE users
          SET totp_enabled = FALSE,
              totp_secret = NULL,
              totp_recovery_codes = '{}'
        WHERE id = $1`,
      [userId],
    );

    return res.json({ disabled: true, viaRecoveryCode: viaRecovery });
  } catch (err) {
    console.error('[2fa] /disable error:', err);
    res.status(500).json({ error: '2FA disable failed' });
  }
});

// ── POST /auth/2fa/challenge ─────────────────────────────────────────
// Pre-session — verifies the second factor in the login flow.
router.post('/challenge', challengeLimit, async (req, res) => {
  try {
    const { challenge, code, recoveryCode } = req.body || {};
    if (!challenge) {
      return res.status(400).json({ error: 'challenge token is required' });
    }
    if (!code && !recoveryCode) {
      return res.status(400).json({ error: 'code or recoveryCode is required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(challenge, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      return res.status(401).json({ error: 'Challenge expired. Sign in again.' });
    }
    if (decoded?.purpose !== CHALLENGE_PURPOSE) {
      // Hard reject: someone tried to use a normal session token as a
      // challenge. Don't accept it even if it's still valid.
      return res.status(401).json({ error: 'Invalid challenge token.' });
    }
    const userId = decoded.userId;

    const { rows } = await pool.query(
      // NOTE: do NOT select move_in_date here — that column doesn't exist
      // on the production users table (it's never written, and isn't in
      // schema.sql or any migration), so selecting it made this query throw
      // "column move_in_date does not exist". That 500'd the WHOLE /challenge
      // handler before it ever checked the TOTP or recovery code — so a
      // correct authenticator code AND a valid recovery code both came back
      // as "we hit a snag verifying that code." The response below keeps the
      // moveInDate field, defaulting to null (its real value anyway).
      `SELECT id, email, school, first_name, last_name, bio, major, school_year,
              age, gender, looking_for, photo_url, budget_min, budget_max,
              neighborhoods, is_verified, trust_score, quiz_completed,
              identity_verified_at, totp_secret, totp_enabled, totp_recovery_codes
         FROM users WHERE id = $1`,
      [userId],
    );
    const u = rows[0];
    if (!u) {
      return res.status(401).json({ error: 'Sign in again.' });
    }
    // Gate-disabled fast path. If 2FA has been turned off on this
    // account (totp_enabled FALSE OR totp_secret NULL), just complete
    // the sign-in instead of returning 401. Otherwise users sitting
    // on a stale challenge URL after we cleared their flag can't
    // get through. The challenge JWT was issued during a real
    // verify-code (signed with our secret), so honoring it once
    // doesn't bypass any security boundary.
    if (!u.totp_enabled || !u.totp_secret) {
      const token = signToken(u.id);
      setSessionCookie(res, token);   // no-op until COOKIE_AUTH_ENABLED (staged migration)
      return res.json({
        success: true,
        token,
        userId: u.id,
        quizCompleted: u.quiz_completed,
        profile: {
          id:             u.id,
          email:          u.email,
          school:         u.school,
          firstName:      u.first_name,
          lastName:       u.last_name,
          lastInitial:    u.last_name ? u.last_name.trim().charAt(0) : '',
          bio:            u.bio || '',
          major:          u.major || '',
          schoolYear:     u.school_year || '',
          age:            u.age ?? null,
          gender:         u.gender || '',
          lookingFor:     u.looking_for || [],
          photoUrl:       u.photo_url || null,
          budgetMin:      u.budget_min ?? null,
          budgetMax:      u.budget_max ?? null,
          neighborhoods:  u.neighborhoods || [],
          moveInDate:     u.move_in_date || null,
          isVerified:     u.is_verified,
          trustScore:     u.trust_score,
          quizCompleted:  u.quiz_completed,
          identityVerifiedAt: u.identity_verified_at,
          totpEnabled:    false,
        },
      });
    }

    let authorized = false;

    if (code) {
      authorized = authenticator.check(String(code).trim(), u.totp_secret);
    }
    if (!authorized && recoveryCode) {
      // consumeRecoveryCodeAtomic does the row-level lock, constant-time
      // bcrypt loop, and the array UPDATE in a single transaction — so
      // the same recovery code can never be used twice even under
      // concurrent /challenge requests.
      const result = await consumeRecoveryCodeAtomic(userId, recoveryCode);
      authorized = result.matched;
    }
    if (!authorized) {
      return res.status(400).json({ error: 'Incorrect code. Try the current 6 digits or a recovery code.' });
    }

    // Record the successful sign-in for the user's Recent activity card.
    // Fire-and-forget — a DB hiccup shouldn't break the auth response.
    // The method distinguishes a TOTP code from a recovery code so the
    // user can spot suspicious recovery-code activity.
    pool.query(
      'INSERT INTO sign_in_events (user_id, method, ip_prefix, user_agent) VALUES ($1,$2,$3,$4)',
      [
        u.id,
        recoveryCode ? 'recovery_code' : '2fa',
        (() => {
          const fullIp = req.ip || req.headers['x-forwarded-for'] || '';
          if (fullIp.includes(':')) return fullIp.split(':').slice(0, 3).join(':') + '::/48';
          if (fullIp) return fullIp.split('.').slice(0, 3).join('.') + '.0/24';
          return null;
        })(),
        (req.headers['user-agent'] || '').toString().slice(0, 256) || null,
      ],
    ).catch(err => console.error('[2fa] sign-in audit write failed:', err.message));

    const token = signToken(u.id);
    setSessionCookie(res, token);   // no-op until COOKIE_AUTH_ENABLED (staged migration)
    return res.json({
      success: true,
      token,
      userId: u.id,
      quizCompleted: u.quiz_completed,
      profile: {
        id:             u.id,
        email:          u.email,
        school:         u.school,
        firstName:      u.first_name,
        lastName:       u.last_name,
        lastInitial:    u.last_name ? u.last_name.trim().charAt(0) : '',
        bio:            u.bio || '',
        major:          u.major || '',
        schoolYear:     u.school_year || '',
        age:            u.age ?? null,
        gender:         u.gender || '',
        lookingFor:     u.looking_for || [],
        photoUrl:       u.photo_url || null,
        budgetMin:      u.budget_min ?? null,
        budgetMax:      u.budget_max ?? null,
        neighborhoods:  u.neighborhoods || [],
        moveInDate:     u.move_in_date || null,
        isVerified:     u.is_verified,
        trustScore:     u.trust_score,
        quizCompleted:  u.quiz_completed,
        identityVerifiedAt: u.identity_verified_at,
        // We only get here when totp_enabled was true. Echo it back so
        // the frontend's authStore writes the correct Profile-toggle
        // state without a follow-up /users/me call.
        totpEnabled:    true,
      },
    });
  } catch (err) {
    console.error('[2fa] /challenge error:', err);
    // Warm voice — this string surfaces directly inside the sign-in
    // editorial flow. Kept generic since the 500 path covers a grab-bag
    // of internal failures we can't usefully name to the user.
    res.status(500).json({ error: "we hit a snag verifying that code. give it a moment, then try again." });
  }
});

// ── Helpers exported for /auth/verify-code to issue a challenge ──────
function signChallengeToken(userId) {
  return jwt.sign(
    { userId, purpose: CHALLENGE_PURPOSE },
    process.env.JWT_SECRET,
    { expiresIn: CHALLENGE_TTL_SECONDS },
  );
}

module.exports = router;
module.exports.signChallengeToken = signChallengeToken;
module.exports.CHALLENGE_PURPOSE  = CHALLENGE_PURPOSE;
