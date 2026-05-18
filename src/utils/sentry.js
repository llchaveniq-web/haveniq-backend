/**
 * Sentry initialization — optional, off by default.
 *
 * To enable in production:
 *   1. Sign up at https://sentry.io (free tier: 5K errors/month)
 *   2. Create a Node.js project, copy the DSN
 *   3. Add to Railway env vars: SENTRY_DSN=https://your-key@oXXXXXX.ingest.sentry.io/...
 *   4. SSH into a one-off build (or just push) — Railway will run npm install
 *   5. Add to package.json: "@sentry/node": "^9.0.0" then `npm install`
 *
 * Until both the DSN is set AND the package is installed, this file is a
 * pure no-op — no errors thrown, no slowdown at startup. Wraps every
 * require() in a try/catch so a missing package doesn't crash the
 * server.
 *
 * Why optional: HavenIQ is pre-revenue. We don't want to gate the
 * server on a non-essential dep. Once you have 50+ active students and
 * a real "we need to know when stuff breaks" budget, flip this on by
 * adding the DSN and installing the package.
 */

let Sentry = null;
let initialized = false;

function tryInit() {
  if (initialized) return Sentry;
  initialized = true;

  if (!process.env.SENTRY_DSN) {
    return null;
  }

  try {
    // eslint-disable-next-line global-require
    Sentry = require('@sentry/node');
  } catch {
    console.warn('[sentry] @sentry/node not installed — skipping. Add the package to enable error monitoring.');
    return null;
  }

  try {
    Sentry.init({
      dsn:              process.env.SENTRY_DSN,
      environment:      process.env.NODE_ENV || 'development',
      tracesSampleRate: 0.1,  // sample 10% of requests for performance monitoring
      release:          process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown',
    });
    console.log('[sentry] initialized for', process.env.NODE_ENV || 'development');
    return Sentry;
  } catch (err) {
    console.error('[sentry] init failed:', err);
    return null;
  }
}

/** Manually capture an error from anywhere in the app (no-op when off). */
function captureError(err, context) {
  const s = tryInit();
  if (!s) return;
  try {
    s.captureException(err, context ? { extra: context } : undefined);
  } catch {
    // Don't let monitoring failures take down the request.
  }
}

/** Express error-handling middleware (no-op when off). */
function errorMiddleware() {
  const s = tryInit();
  if (!s) return (err, req, res, next) => next(err);
  return s.expressErrorHandler ? s.expressErrorHandler() : (err, req, res, next) => {
    s.captureException(err);
    next(err);
  };
}

/** Express request-handling middleware (no-op when off). */
function requestMiddleware() {
  const s = tryInit();
  if (!s) return (req, res, next) => next();
  return s.expressRequestHandler ? s.expressRequestHandler() : (req, res, next) => next();
}

module.exports = { tryInit, captureError, errorMiddleware, requestMiddleware };
