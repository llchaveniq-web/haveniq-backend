// Thin wrapper around express-rate-limit that adds ONE thing: a global
// kill-switch (env RATE_LIMIT_DISABLED=true) so every limiter built through it
// can be relaxed at once — used ONLY on the staging load-test environment so a
// k6 arrival-rate ramp isn't throttled by the per-IP / per-email / global caps.
//
// PRODUCTION SAFETY: the switch is pure opt-in — limiters stay ON unless the
// env var is set to the exact string 'true'. Production simply never sets it,
// so its per-IP + per-email auth limiters (and the global 200/15min) keep
// running unchanged. If the flag is ever set we log a loud one-time banner at
// boot so an accidental prod setting can't hide.
//
// Every rate limiter in the app is built through THIS module (the raw
// `express-rate-limit` import was swapped for it), so the switch is complete —
// no limiter is silently exempt from, or silently immune to, the toggle.

const expressRateLimit = require('express-rate-limit');
const { ipKeyGenerator } = expressRateLimit;

/** True only when the staging kill-switch is explicitly enabled. */
function rateLimitingDisabled() {
  return process.env.RATE_LIMIT_DISABLED === 'true';
}

// Loud, one-time boot banner. Fires when this module first loads (server start)
// so a running instance with limiters OFF is never a silent surprise.
if (rateLimitingDisabled()) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n' +
    '  ╔══════════════════════════════════════════════════════════════╗\n' +
    '  ║  RATE_LIMIT_DISABLED=true — ALL rate limiters are OFF.        ║\n' +
    '  ║  This must ONLY be set on the staging load-test environment.  ║\n' +
    '  ║  If you see this in production, unset it immediately.         ║\n' +
    '  ╚══════════════════════════════════════════════════════════════╝\n'
  );
}

// Drop-in replacement for `rateLimit(options)`. Injects a `skip` that short-
// circuits when the kill-switch is on, while preserving any caller-supplied
// `skip` (e.g. the bot-token exemption on the global limiter). `skip` is
// evaluated per request, so the flag is honored for the life of the process
// from the value present at boot.
function makeRateLimit(options = {}) {
  const callerSkip = options.skip;
  return expressRateLimit({
    ...options,
    skip: (req, res) => {
      if (rateLimitingDisabled()) return true;
      return callerSkip ? callerSkip(req, res) : false;
    },
  });
}

// Re-export helpers callers destructure from the original module.
makeRateLimit.ipKeyGenerator = ipKeyGenerator;
makeRateLimit.rateLimitingDisabled = rateLimitingDisabled;

module.exports = makeRateLimit;
