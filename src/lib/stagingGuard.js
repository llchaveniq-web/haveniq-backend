/**
 * Staging-only bypass gate.
 *
 * Everything gated through here WEAKENS AUTHENTICATION on purpose (a demo
 * session with no email, a relaxed .edu check, a fixed OTP). On production any
 * one of them is a full signup bypass, so the gate is built to fail closed and
 * to be impossible to open on prod by setting a single variable.
 *
 * WHY NOT `NODE_ENV === 'staging'` (what the spec asked for):
 * verified 2026-07-22 against Railway — BOTH environments run NODE_ENV
 * "production". The only variable that actually distinguishes them is
 * RAILWAY_ENVIRONMENT ("production" vs "staging"). A NODE_ENV check would have
 * 404'd on staging too, so the demo button would never have worked.
 *
 * And NODE_ENV must NOT be changed to "staging" to make that check work: the
 * codebase keys real behavior off it, and flipping it would
 *   - disable Postgres SSL (db/pool.js) — Railway's proxy requires it, so the
 *     staging DB would stop connecting at all,
 *   - print cleartext OTP codes into the logs (routes/auth.js),
 *   - skip the required-secret boot check and allow wildcard CORS (server.js).
 *
 * THE GATE — a bypass is live only when BOTH hold:
 *   1. RAILWAY_ENVIRONMENT is not "production"  (hard deny; no flag overrides it)
 *   2. its own opt-in env var is exactly "true" (absent ⇒ closed)
 * Two independent conditions, so a mis-set flag alone can never open a bypass
 * on production. Outside Railway (local dev) condition 1 passes and the
 * explicit flag is still required.
 */

/** True when this process is the production deployment. */
function isProdEnvironment() {
  return String(process.env.RAILWAY_ENVIRONMENT || '').trim().toLowerCase() === 'production';
}

/**
 * TEMPORARY, DELIBERATE production override (founder-authorized 2026-07-22 for
 * an advisor review under time pressure).
 *
 * When ALLOW_PROD_DEMO_BYPASS=true, production stops hard-denying the bypasses
 * below — i.e. anyone who can reach the API can mint a session with no email
 * and no OTP, and non-.edu addresses are accepted. That is a full signup
 * bypass on the live app and it contradicts the "verified students only"
 * promise in the TOS/privacy policy.
 *
 * It is a SEPARATE variable from the feature flags on purpose: turning a single
 * flag on can never do this by accident — you have to set this one too, and its
 * name says exactly what it does. TURN IT OFF the moment the review is over:
 *   railway variables -e production -s haveniq-backend --set ALLOW_PROD_DEMO_BYPASS=false
 */
function prodBypassAuthorized() {
  return String(process.env.ALLOW_PROD_DEMO_BYPASS || '').trim().toLowerCase() === 'true';
}

/**
 * Is `name` an enabled staging bypass? Always false on production, whatever
 * the variable says.
 */
function stagingFlag(name) {
  if (isProdEnvironment() && !prodBypassAuthorized()) return false;
  return String(process.env[name] || '').trim().toLowerCase() === 'true';
}

/**
 * The fixed staging OTP, or null. Only usable off production, and only when it
 * is a plausible 6-digit code — a short or blank value would otherwise turn
 * into a trivially guessable master code.
 */
function stagingOtp() {
  if (isProdEnvironment() && !prodBypassAuthorized()) return null;
  const v = String(process.env.STAGING_LOGIN_OTP || '').trim();
  return /^\d{6}$/.test(v) ? v : null;
}

/**
 * Log the live bypasses once at boot so an operator can SEE them in the deploy
 * log, and shout if one is somehow configured on production (the gate already
 * refuses it — this makes the misconfiguration visible rather than silent).
 */
function logStagingBypasses(log = console) {
  const configured = ['ALLOW_DEMO_SESSION', 'ALLOW_ANY_EMAIL_DOMAIN']
    .filter((k) => String(process.env[k] || '').trim().toLowerCase() === 'true');
  if (String(process.env.STAGING_LOGIN_OTP || '').trim()) configured.push('STAGING_LOGIN_OTP');
  if (!configured.length) return;

  if (isProdEnvironment()) {
    log.error('[staging-guard] REFUSING auth bypasses configured on PRODUCTION:',
      configured.join(', '), '— these are ignored. Remove them from the prod environment.');
    return;
  }
  log.warn('[staging-guard] auth bypasses ACTIVE (non-production):', configured.join(', '));
}

module.exports = { isProdEnvironment, prodBypassAuthorized, stagingFlag, stagingOtp, logStagingBypasses };
