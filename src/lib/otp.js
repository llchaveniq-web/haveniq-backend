// Single source of truth for the OTP hash + attempt cap, shared by the auth flow
// (issue/verify in routes/auth.js) and the founder account-support endpoints
// (resend/unlock in routes/admin.js). Keeping these here means resend and verify
// can never drift out of lockstep — a mismatched hash would silently issue codes
// that /verify-code rejects.

const crypto = require('crypto');

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

module.exports = { hashOtp, MAX_OTP_ATTEMPTS };
