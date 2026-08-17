// ─── PostHog server-side analytics ────────────────────────────────────────
//
// Mirror of the frontend's services/analytics.ts — same event-name
// convention, same identify pattern, but for things only the server knows:
//
//   • match_created       — matcher created a new compatibility row
//   • email_sent          — every transactional email (welcome, OTP, etc.)
//   • connect_request_received — fires on the RECIPIENT'S timeline when
//                                A sends a request to B (the frontend can
//                                only fire connect_request_sent for A)
//   • pulse_submitted     — 30/60/90-day outcome check-in answer
//   • user_banned         — admin action (founder-gated safety route)
//   • user_blocked        — user-initiated block on another user
//   • report_submitted    — user reported another user
//
// Why server-side: the frontend can only see what its session sees.
// Backend events catch the half of the funnel that happens while a
// user is offline (someone messaged me, I got matched while sleeping).
// Without these, "I got 3 new matches" never appears as an event
// until I open the app — by which point the timing of the match is
// lost.
//
// Graceful: same opt-in pattern as Sentry + frontend PostHog. If
// POSTHOG_API_KEY is missing (dev, CI, builds that haven't been
// keyed), every helper no-ops. App boot is never blocked by analytics.

const { PostHog } = require('posthog-node');

let client = null;

/**
 * Initialize PostHog. Called once at app startup (see src/index.js).
 * Idempotent. No-op without a key.
 */
function init() {
  if (client) return; // already initialized
  const key  = process.env.POSTHOG_API_KEY;
  const host = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
  if (!key) return;

  try {
    client = new PostHog(key, {
      host,
      // Server-side batches events and flushes periodically. The defaults
      // (20 events or 10s) are fine for HavenIQ's volume.
      flushAt:       20,
      flushInterval: 10000,
    });
  } catch {
    // Never block boot on analytics.
  }
}

/**
 * Track a server-side event. The `distinctId` should be the user's UUID
 * from the database — same id we use to identify on the frontend. This
 * stitches server events into the same user timeline as their frontend
 * actions.
 *
 * Pass null for `distinctId` for system-wide events with no user
 * (e.g. cron jobs) — PostHog will record it under a server-generated id.
 */
function track(event, distinctId, properties) {
  if (!client) return;
  try {
    client.capture({
      distinctId: distinctId || 'system',
      event,
      properties: properties || {},
    });
  } catch { /* swallow */ }
}

/**
 * Attach traits to a user. Call after signup so PostHog has the user's
 * school, signup date, etc. The frontend already calls identify() with
 * a subset; calling it again from the backend with the same distinct_id
 * just merges traits — no duplicates.
 */
function identify(distinctId, traits) {
  if (!client || !distinctId) return;
  try {
    client.identify({
      distinctId,
      properties: traits || {},
    });
  } catch { /* swallow */ }
}

/**
 * Flush + close the queue. Called on graceful shutdown (SIGTERM /
 * SIGINT) so we don't lose buffered events when Railway redeploys.
 */
async function shutdown() {
  if (!client) return;
  try {
    await client.shutdown();
  } catch { /* swallow */ }
}

// Canonical event names. Adding a new event? Add it here first so
// PostHog dashboards stay clean and predictable. Mirror naming with
// the frontend (snake_case verbs, past tense for completed actions).
const EVENTS = {
  // ── Lifecycle ────────────────────────────────────────────────────
  signup_completed_server:    'signup_completed_server',  // post-signup, after row insert
  email_verified:             'email_verified',

  // ── Matching ─────────────────────────────────────────────────────
  match_created:              'match_created',            // { user_a_id, user_b_id, score, tier }
  connect_request_received:   'connect_request_received', // fires on recipient
  connect_request_expired:    'connect_request_expired',  // never answered, auto-aged
  scoring_skipped_unverified: 'scoring_skipped_unverified', // quiz submitted but is_verified=false blocked scoring entirely — was previously invisible

  // ── Messaging ────────────────────────────────────────────────────
  message_received:           'message_received',         // fires on recipient
  message_blocked:            'message_blocked',          // sender is banned/blocked

  // ── Outcomes ─────────────────────────────────────────────────────
  pulse_submitted:            'pulse_submitted',          // 30/60/90-day check-in
  pulse_due:                  'pulse_due',                // backend created a pending pulse

  // ── Transactional email ──────────────────────────────────────────
  email_sent:                 'email_sent',               // { kind: 'welcome'|'otp'|'match'|'parent_invite'|... }
  email_failed:               'email_failed',

  // ── Safety / moderation ──────────────────────────────────────────
  report_submitted:           'report_submitted',         // { target_user_id, reason }
  user_blocked:               'user_blocked',             // { target_user_id }
  user_banned:                'user_banned',              // admin action — { target_user_id, reason }
  user_unbanned:              'user_unbanned',
  photo_flagged_nsfw:         'photo_flagged_nsfw',       // Cloudinary moderation hit

  // ── AI / costs ───────────────────────────────────────────────────
  ai_call_made:               'ai_call_made',             // { persona, tokens_in, tokens_out, model }
  ai_call_failed:             'ai_call_failed',

  // ── Integrations ─────────────────────────────────────────────────
  plaid_linked:               'plaid_linked',
  plaid_disconnected:         'plaid_disconnected',
  identity_verified:          'identity_verified',        // Stripe Identity success

  // ── Security / abuse signals ─────────────────────────────────────
  // Emitted by middleware/suspiciousActivity.js when a logged-in user
  // exceeds a per-route per-window threshold. Use to drive a PostHog
  // alert: "if suspicious_activity count > 0 in last 1h, email me."
  suspicious_activity:        'suspicious_activity',
};

module.exports = { init, track, identify, shutdown, EVENTS };
