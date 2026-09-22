// Single source of truth for the OTP hash + attempt cap, shared by the auth flow
// (issue/verify in routes/auth.js) and the founder account-support endpoints
// (resend/unlock in routes/admin.js). Keeping these here means resend and verify
// can never drift out of lockstep — a mismatched hash would silently issue codes
// that /verify-code rejects.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Max wrong /verify-code attempts before a code is burned.
const MAX_OTP_ATTEMPTS = 3;

// Hash an OTP for at-rest storage. We never want the cleartext on disk — a DB
// dump would expose every in-flight code otherwise. The JWT_SECRET pepper means
// a stolen DB without the secret can't be brute-forced offline.
function hashOtp(code) {
  return crypto
    .createHash('sha256')
    .update(`${code}:${process.env.JWT_SECRET}`)
    .digest('hex');
}

// A handle on ONE issued code, given to the client that requested it.
//
// The code screen needs to ask "did that email reach the school", and the
// obvious way to ask is by email address. That would be a free oracle: anyone
// could probe any address and learn whether a signup was in flight for it, and
// what a university's mail server did with it. So the question is keyed on a
// signed handle to a specific row instead. You can only ask about a code you
// yourself asked for, and the handle dies with the code.
//
// Signed rather than stored so this needs no column and no migration: the row
// id is in the token, and the signature is what makes it unforgeable.
const CODE_REF_PURPOSE = 'otp-status';
const CODE_REF_TTL_SEC = 15 * 60; // outlives the 10 minute code, barely

function signCodeRef(otpId) {
  return jwt.sign(
    { otpId, purpose: CODE_REF_PURPOSE },
    process.env.JWT_SECRET,
    { expiresIn: CODE_REF_TTL_SEC },
  );
}

// Returns the otp row id, or null for anything that is not a live ref we
// issued: bad signature, expired, or a token minted for some other purpose.
// The purpose check is the important one. Every token in this system is signed
// with the same secret, so without it a session JWT would be accepted here.
function readCodeRef(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const claims = jwt.verify(token, process.env.JWT_SECRET);
    if (claims?.purpose !== CODE_REF_PURPOSE) return null;
    return claims.otpId ?? null;
  } catch {
    return null;
  }
}

module.exports = {
  hashOtp, MAX_OTP_ATTEMPTS,
  signCodeRef, readCodeRef, CODE_REF_PURPOSE, CODE_REF_TTL_SEC,
};
