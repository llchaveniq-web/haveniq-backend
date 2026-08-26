require('dotenv').config();

// Fail-fast on missing production secrets. Without this guard a deploy
// that loses RESEND_API_KEY silently 200s every /send-code call but
// never delivers an email — users see "code sent" and stare at an
// empty inbox. We'd rather not boot than ship a broken signup funnel.
if (process.env.NODE_ENV === 'production') {
  const required = ['RESEND_API_KEY', 'JWT_SECRET', 'DATABASE_URL'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`[fatal] Missing required env var(s) in production: ${missing.join(', ')}`);
    process.exit(1);
  }
}

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('./lib/rateLimit');
const pool       = require('./db/pool');
const { requireAuth }  = require('./middleware/auth');
const sentry            = require('./utils/sentry');
const analytics         = require('./services/analytics');

// ── CORS configuration ────────────────────────────────────────────────────
// Production requires an explicit CLIENT_URL (comma-separated list of
// origins). In production the previous fallback to '*' meant a missing
// env var on a future deploy silently opened the API to any origin.
// Dev defaults to '*' for convenience and warns loudly.
const isProd = process.env.NODE_ENV === 'production';
const rawAllowed = (process.env.CLIENT_URL || '').trim();
if (isProd && !rawAllowed) {
  // eslint-disable-next-line no-console
  console.error('[fatal] CLIENT_URL must be set in production. Comma-separated list of allowed origins, e.g. "https://app.haveniq.org,https://haveniq.org".');
  process.exit(1);
}
const allowedOrigins = rawAllowed
  ? rawAllowed.split(',').map(s => s.trim()).filter(Boolean)
  : ['*'];
if (!isProd && allowedOrigins.includes('*')) {
  // eslint-disable-next-line no-console
  console.warn('[cors] CLIENT_URL not set — defaulting to "*" for dev. Set it for production.');
}
// Cloudflare Pages always serves the same app at THREE shapes of URL:
//   • haveniq-app.pages.dev          (production alias)
//   • master.haveniq-app.pages.dev   (master branch alias)
//   • <hash>.haveniq-app.pages.dev   (per-deployment immutable URL)
// All three are us. Always allow them so the original CORS-rejection
// class of bug (Sentry NODE-1) can never re-fire just because a user
// hit a different alias of our own frontend.
const PAGES_DEV_HOST = /^https:\/\/([a-z0-9-]+\.)?haveniq-app\.pages\.dev$/i;
// Production app origins — ALWAYS trusted for both the HTTP API and the
// socket.io server (presence / typing / live incoming messages), regardless of
// the CLIENT_URL env var. socket.io reuses this same `corsOrigin`, so a missing
// or misset CLIENT_URL can no longer silently block real-time on the live app.
// `app.haveniq.org` = the SPA; `haveniq.org` = the marketing site.
const PROD_APP_HOST = /^https:\/\/(app\.)?haveniq\.org$/i;

const corsOrigin = allowedOrigins.includes('*')
  ? true  // express-cors treats `true` as "reflect request origin" — works for browsers but doesn't accept credentials with `*` literal
  : (origin, cb) => {
      // Same-origin / curl requests have no Origin header — let them through.
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      // Our own production origins + Cloudflare Pages aliases — always trusted,
      // regardless of CLIENT_URL.
      if (PROD_APP_HOST.test(origin) || PAGES_DEV_HOST.test(origin)) return cb(null, true);
      cb(new Error(`CORS: ${origin} not in allowed list`));
    };

// Sentry — opt-in error monitoring. No-op unless SENTRY_DSN env var is
// set AND @sentry/node is installed. See utils/sentry.js for setup
// instructions. Initialize as early as possible so initialization
// errors elsewhere still get captured.
sentry.tryInit();

// PostHog — opt-in server-side product analytics. No-op unless
// POSTHOG_API_KEY is set. Catches the half of the funnel that the
// frontend can't see (offline notifications, async match creation,
// email deliveries, AI cost per call, safety actions).
analytics.init();

// Graceful shutdown — flush queued PostHog events so we don't lose
// the last 10s of activity when Railway redeploys.
['SIGTERM', 'SIGINT'].forEach((sig) => {
  process.on(sig, async () => {
    try { await analytics.shutdown(); } catch {}
    process.exit(0);
  });
});

const app    = express();
app.set('trust proxy', 1); // Required for Railway / reverse proxies
const server = http.createServer(app);

// ── Sentry tunnel — mounted FIRST, before any other middleware ──────────
// Why: helmet, the global json/urlencoded parsers, and the rate limiter
// were collectively rejecting POSTs with content-type
// 'application/x-sentry-envelope' (returning empty 400 with no body)
// despite each one nominally skipping non-matching content-types.
// Mounting here, before everything, sidesteps the entire middleware
// chain — the tunnel route handles its own express.raw() body parsing
// and writes its own CORS headers via a tiny inline middleware so the
// frontend can POST cross-origin from app.haveniq.org.
app.use('/api', (req, res, next) => {
  // Inline CORS for this route only — needed because we run BEFORE
  // the global cors() middleware. Accepts any origin (the route only
  // accepts envelope POSTs, no credentials, so origin doesn't matter
  // for security here).
  res.setHeader('Access-Control-Allow-Origin',  req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-sentry-auth, sentry-trace, baggage');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}, require('./routes/sentryTunnel'));

// ── Resend bounce webhook — mounted BEFORE express.json so we can
//    keep the raw bytes for HMAC signature verification. Resend signs
//    the exact body it sent; if json() runs first and reserializes,
//    every signature check fails.
app.use(
  '/webhooks/resend',
  express.raw({ type: 'application/json', limit: '64kb' }),
  (req, res, next) => {
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body;
      try { req.body = JSON.parse(req.body.toString('utf8')); }
      catch { return res.status(400).json({ error: 'invalid json' }); }
    }
    next();
  },
  require('./routes/resendWebhook'),
);

// ── Socket.io (real-time: presence / typing / live incoming + read receipts) ─
//
// As of 2026-06-24 (1b) the web client at app.haveniq.org IS allowed to connect
// (PROD_APP_HOST is trusted by corsOrigin above), so the app's messageSocket
// can receive live incoming messages, typing dots, presence, and read receipts
// without a refresh.
//
// ⚠️  MESSAGE SENDING STAYS ON THE HTTP PATH (matchStore.sendMessage → POST
// /messages). The socket is RECEIVE-ONLY for the web client. Do NOT wire the
// web client to emit `send_message`: the HTTP POST and the socket insert would
// BOTH write to `messages` and silently double every sent message. (A future
// native build can pick ONE path.)
const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    // Allow the httpOnly session cookie on the WS handshake (cookie-auth mode).
    // Harmless for bearer/native clients, which authenticate via the auth payload.
    credentials: true,
  },
});

// Socket auth middleware
io.use(async (socket, next) => {
  try {
    // Token from the socket.io `auth` payload (native/bearer clients) OR, in
    // cookie-auth mode, the httpOnly session cookie sent on the WS handshake.
    const token = socket.handshake.auth.token
      || require('./lib/sessionCookie').readTokenCookie({ headers: socket.handshake.headers });
    if (!token) throw new Error('No token');

    const jwt    = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    const { rows } = await pool.query(
      'SELECT id, first_name, is_banned FROM users WHERE id = $1',
      [decoded.userId]
    );
    if (!rows[0]) throw new Error('User not found');
    // Banned users are refused at the socket door — same as refuseBanned on the
    // HTTP routes. Without this a suspended account holding a valid JWT could
    // still open a socket (and, before the write handler was removed, message
    // through it), bypassing the ban.
    if (rows[0].is_banned) throw new Error('Account suspended');

    socket.userId    = rows[0].id;
    socket.firstName = rows[0].first_name;
    next();
  } catch (err) {
    next(new Error('Authentication failed'));
  }
});

// ── Real-time presence ──────────────────────────────────────────────────────
// onlineCounts: userId → number of live sockets (ref-count so multiple tabs /
// devices for one person are handled — they go "offline" only when the LAST
// socket drops). presenceWatchers: watchedUserId → sockets that asked to be
// told when that user goes on/offline (an open chat thread subscribes to the
// other person). Both in-memory — presence is ephemeral; a restart re-derives
// it as clients reconnect.
const onlineCounts     = new Map(); // userId -> count
const presenceWatchers = new Map(); // watchedUserId -> Set<socket>
const isUserOnline = (uid) => (onlineCounts.get(uid) || 0) > 0;
function notifyPresence(uid) {
  const set = presenceWatchers.get(uid);
  if (!set || set.size === 0) return;
  const payload = { userId: uid, online: isUserOnline(uid) };
  for (const s of set) s.emit('presence', payload);
}

// Is this authenticated socket actually a participant of the conversation?
// The socket is authenticated, but authentication is not authorization: without
// this, any logged-in user could join conv:<id>, emit/receive typing + read
// receipts, and mark_read messages in a conversation they aren't part of.
// Mirrors the REST membership check in messages.js. Any error (e.g. a non-uuid
// id) fails closed to `false`.
async function socketInConversation(conversationId, userId) {
  if (!conversationId || typeof conversationId !== 'string') return false;
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM conversations WHERE id = $1 AND (user_a = $2 OR user_b = $2) LIMIT 1',
      [conversationId, userId],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

io.on('connection', (socket) => {
  console.log(`⚡ Socket connected: ${socket.firstName || socket.userId}`);

  // Join personal room (for DMs)
  socket.join(`user:${socket.userId}`);

  // Mark online (ref-counted). Only the 0→1 transition is a real "came online"
  // event worth pushing to watchers.
  {
    const n = (onlineCounts.get(socket.userId) || 0) + 1;
    onlineCounts.set(socket.userId, n);
    if (n === 1) notifyPresence(socket.userId);
  }

  // A client (the open chat thread) subscribes to another user's live presence.
  // We reply immediately with the current state, then push future changes.
  socket.on('presence:watch', (watchedId) => {
    if (!watchedId || typeof watchedId !== 'string') return;
    if (watchedId === socket.userId) return; // no point watching your own presence
    let set = presenceWatchers.get(watchedId);
    if (!set) { set = new Set(); presenceWatchers.set(watchedId, set); }
    set.add(socket);
    socket.emit('presence', { userId: watchedId, online: isUserOnline(watchedId) });
  });
  socket.on('presence:unwatch', (watchedId) => {
    const set = presenceWatchers.get(watchedId);
    if (set) { set.delete(socket); if (set.size === 0) presenceWatchers.delete(watchedId); }
  });

  // Join a conversation room — only if the socket's user is a participant.
  socket.on('join_conversation', async (conversationId) => {
    if (!(await socketInConversation(conversationId, socket.userId))) return;
    socket.join(`conv:${conversationId}`);
  });

  // Send a message
  // NOTE: the `send_message` socket write handler was REMOVED (2026-07-09
  // red-team pass). The client never emits it — all message creation goes
  // through POST /messages/:conversationId, which runs contentFilter
  // moderation (scam/harassment screening) AND refuseBanned. The socket
  // handler did neither: it wrote straight to the messages table, so a
  // crafted socket emit could send messages that bypassed BOTH moderation and
  // the ban. The socket is receive-only (new_message is broadcast from the
  // HTTP route). Do not re-add a socket write path without porting the
  // moderation + ban checks; better to keep writes on the single guarded HTTP
  // route.

  // Typing indicator — only broadcast into conversations the user belongs to.
  socket.on('typing', async ({ conversationId, isTyping } = {}) => {
    if (!(await socketInConversation(conversationId, socket.userId))) return;
    socket.to(`conv:${conversationId}`).emit('user_typing', {
      userId: socket.userId,
      isTyping,
    });
  });

  // Read receipts: when a client reads a thread, mark the OTHER side's unread
  // messages read and broadcast so the sender's ticks update live. read_at is
  // added by migrate_missing.sql. Best-effort — a DB error must never crash
  // the socket connection (mirrors the send_message try/catch above).
  socket.on('mark_read', async ({ conversationId } = {}) => {
    if (!conversationId) return;
    // Authorization: only a participant may mark this conversation's messages
    // read. Without this, any authed user could flip B↔C's messages to read
    // and silently clear the other party's unread badge.
    if (!(await socketInConversation(conversationId, socket.userId))) return;
    try {
      const readAt = new Date().toISOString();
      await pool.query(
        `UPDATE messages SET read = true, read_at = $1
         WHERE conversation_id = $2 AND sender_id <> $3 AND read = false`,
        [readAt, conversationId, socket.userId],
      );
      io.to(`conv:${conversationId}`).emit('messages_read', {
        conversationId, readerId: socket.userId, readAt,
      });
    } catch (err) {
      console.error('[socket mark_read] failed:', err.message);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.userId}`);
    // Decrement online ref-count; on the 1→0 transition the user is truly
    // offline → tell watchers. Guards against ghost-online when a tab/device
    // drops without a clean close (socket.io's own heartbeat fires this).
    const n = (onlineCounts.get(socket.userId) || 1) - 1;
    if (n <= 0) { onlineCounts.delete(socket.userId); notifyPresence(socket.userId); }
    else onlineCounts.set(socket.userId, n);
    // Drop this socket from any watcher sets it joined (no leaks / stale refs).
    for (const [uid, set] of presenceWatchers) {
      if (set.delete(socket) && set.size === 0) presenceWatchers.delete(uid);
    }
  });
});

// ── Express middleware ────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: corsOrigin,
  // Credentialed cookie auth (httpOnly hq_session): the browser only sends the
  // cookie when the response echoes the EXACT origin (never '*') together with
  // Allow-Credentials. corsOrigin reflects the specific allowed origin, so this
  // is safe. Credentials are disabled only in the dev '*' mode.
  credentials: !allowedOrigins.includes('*'),
  // The web client sends X-HavenIQ-CSRF on every authenticated request; a custom
  // header forces a CORS preflight, which is exactly what makes it a valid CSRF
  // defense — so it MUST be allow-listed here or every cookie-authed request
  // fails preflight. Authorization stays for bearer/native + the transition.
  allowedHeaders: ['Content-Type', 'Authorization', 'X-HavenIQ-CSRF'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// Stripe webhook MUST consume the raw body (not the JSON-parsed one) so
// signature verification works. Mount it BEFORE the global JSON parser
// and let the route file declare its own express.raw() middleware. The
// JSON parser below skips this exact path.
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
  // Parse a body as JSON only when it actually IS JSON. Two exclusions:
  //   1. the Stripe webhook — it needs the raw body for signature checks;
  //   2. anything non-JSON — most importantly multipart/form-data photo
  //      uploads. Without the content-type check, express.json() tried to
  //      JSON.parse the multipart body ("Unexpected token -") and every
  //      photo upload 500'd before it reached multer.
  type: (req) => {
    if (req.originalUrl.startsWith('/premium/webhook')) return false;
    return (req.headers['content-type'] || '').includes('application/json');
  },
}));
app.use(express.urlencoded({ extended: true }));

// Global rate limit
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  // Internal automation bots (signup auto-review, weekly digest, 60-day
  // check-ins) hit /bot-admin/* on cron and would blow through the 200/15min
  // budget. Exempt them — but only when they carry a valid bot token, so the
  // exemption can't be abused to bypass the limit. The bots authenticate with
  // `Authorization: Bearer <ADMIN_BOT_TOKEN>` (see requireBotToken in
  // routes/botAdmin.js and routes/matchOutcomes.js), not x-bot-key.
  skip: (req) => {
    if (!req.path.startsWith('/bot-admin')) return false;
    // Uses the shared constant-time check rather than a local `===` compare
    // (a sixth copy of the secret comparison), and it also recognises the newer
    // X-Internal-Key header — without this an internal caller using that header
    // would be rate-limited like a stranger.
    return require('./middleware/requireInternalKey').hasValidInternalKey(req);
  },
}));

// Per-IP cap on state-changing requests, on top of the global read-sized limit.
// Mounted before the routes so it covers every POST/PUT/PATCH/DELETE without
// each router opting in (the failure mode of per-route limiters is the route
// somebody forgets). Reads, provider webhooks, and key-carrying internal
// callers are skipped — see middleware/rateLimits.js.
app.use(require('./middleware/rateLimits').writeLimiter);

// CSRF guard for cookie-authenticated mutations. Active by default (disable with
// COOKIE_AUTH_ENABLED=false). Auto-skips webhooks, pre-login OTP, and native
// bearer clients — anything carrying no hq_session cookie. See
// middleware/auth.js and docs/COOKIE_AUTH_MIGRATION.md.
app.use(require('./middleware/auth').csrfGuard);

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/auth',     require('./routes/auth'));
// Mount /auth/2fa AFTER /auth so the dedicated twoFactor router owns
// /setup, /verify-setup, /disable, and the /challenge endpoint that
// finishes a 2FA-required sign-in.
app.use('/auth/2fa', require('./routes/twoFactor'));
app.use('/users',    require('./routes/users'));
app.use('/users',    require('./routes/userPhotos')); // multi-photo gallery: /users/:id/photos, /users/me/photos
app.use('/quiz',     require('./routes/quiz'));
app.use('/matches',  require('./routes/matches'));
app.use('/matches',  require('./routes/matchOfTheDay'));  // /matches/today + /matches/today/action
app.use('/matches',  require('./routes/matchedMoment'));  // /matches/matched/:userId
app.use('/daily',    require('./routes/dailyDiscovery')); // /daily/today + /daily/today/answer
app.use('/',         require('./routes/activityPulse'));  // /activity-pulse
app.use('/messages', require('./routes/messages'));
app.use('/agreements', require('./routes/agreements')); // shared roommate agreement per conversation
app.use('/telemetry', require('./routes/telemetry'));
app.use('/analytics', require('./routes/analytics')); // named-event mirror to server-side PostHog (AnalyticsAPI.trackEvent)
// Longitudinal pair dataset export. Research-role only — it is the one surface
// that joins both sides of a pairing (see routes/research.js).
app.use('/research', require('./routes/research'));
// Close the Loop — per-pair event ledger. Ingest is pair-member or internal-key;
// the TIMELINE is research/internal only (it is a record of two real people's
// conflict, so it is never returned to a normal user). See routes/pairs.js.
app.use('/pairs', require('./routes/pairs'));
// Conflict Pulse counterpart read — a student fetches their roommate's own
// conflict_pulse reads about them (GET /conflict-pulse/:matchId). Data is
// ingested via /telemetry/batch → conflict_pulses table.
app.use('/conflict-pulse', require('./routes/conflictPulseJoin'));
app.use('/reviews',  require('./routes/reviews'));
app.use('/pulses',   require('./routes/pulses'));
app.use('/checklists', require('./routes/checklists'));
app.use('/groups',   require('./routes/groups'));
app.use('/feature-state', require('./routes/featureState')); // generic per-feature persistence
app.use('/walkscore', require('./routes/walkscore')); // Walk/Transit/Bike Score proxy (key stays server-side)
app.use('/referrals', require('./routes/referrals')); // unique invite codes + referral attribution
app.use('/circle',    require('./routes/circle'));    // your referred users + compatibility to each
// Cross-referenceable safety record: POST a report, GET /mine, GET /admin
// (founder-only) surfaces same-person-different-reporters patterns. Inert until
// the app adds its third fetch call. See routes/roommateSafety.js.
app.use('/roommate-safety-reports', require('./routes/roommateSafety'));
app.use('/vouches',  require('./routes/vouches'));    // past-roommate vouches (public submit → pending → owner approves)
app.use('/roommate-vouches', require('./routes/roommateVouches')); // mutual, verified — gated to real matched pairs
app.use('/feature-usage', require('./routes/featureUsage')); // real "popular with students" aggregate (distinct users)
app.use('/search',   require('./routes/search'));
app.use('/housing',  require('./routes/housing'));
app.use('/premium',  require('./routes/premium'));
// Outcome-Learning Loop C: per-friction-detector confirmation rates (founder-
// only, GET /admin/friction-validation). Declares its own full path, so no
// prefix. Mounted BEFORE the generic /admin router so it can't be shadowed.
// Inert until the app's check-in emits predictedFrictionCategory/Id +
// frictionConfirmed into match_outcomes.details. See routes/frictionValidation.js.
app.use(require('./routes/frictionValidation'));
app.use('/admin',    require('./routes/admin'));
app.use('/admin/safety', require('./routes/adminSafety'));
app.use('/admin/support', require('./routes/support'));  // "Report a problem" triage queue (founder + moderators)
// Bot-admin: static-token-authed narrow endpoints for automation bots
// (signup auto-review, weekly digest). Returns 503 until ADMIN_BOT_TOKEN
// is set in env.
app.use('/bot-admin', require('./routes/botAdmin'));
// Compatibility Profile — synthesizes user's quiz + bio + messages +
// behavior into a structured personality profile. Routes split between
// /users/me/profile (user-facing) and /bot-admin/synthesize (cron).
app.use('/users', require('./routes/profile'));      // GET/POST/PATCH/DELETE /users/me/profile/*
app.use('/', require('./routes/profile'));            // GET /bot-admin/stale-profiles + POST /bot-admin/synthesize/:userId
// Match Outcomes — the data infrastructure that lets the matching
// algorithm eventually learn from real roommate outcomes. Captures
// 60-day check-ins, lease decisions, ended relationships.
app.use('/users', require('./routes/matchOutcomes')); // /users/me/match-outcomes
app.use('/', require('./routes/matchOutcomes'));      // /bot-admin/pending-checkins + summary + /match-outcomes/calibration
// Outcome-learning Phases 2–4: regularized weight-learning review queue,
// per-school personalization, public proof headline, calibration metrics.
// Human-gated (analyst proposes, founder approves); nothing auto-commits.
app.use('/', require('./routes/weightLearning'));     // /match-outcomes/proof + /bot-admin/weight-* + /weight-proposals/:id/approve
// Watch loop self-reporting status surface (founder-only). The polling job is
// wired on the existing scheduler below; this exposes its rolling history.
app.use('/', require('./routes/ops'));                // /ops/health-history
// One-click unsubscribe for lifecycle/marketing email (signed token = auth, no
// login). Public GET (footer link) + POST (RFC 8058 List-Unsubscribe-Post).
app.use('/', require('./routes/unsubscribe'));        // GET/POST /unsubscribe?token=…
// Tier 3 Sentry webhook — when Sentry detects a new issue, it POSTs here
// within ~5-10 seconds. We triage immediately, post to Discord, and
// dispatch the auto-fix workflow without waiting for the every-15-min
// cron. End-to-end: error → production fix in ~5-7 min for safe bugs.
app.use('/sentry', require('./routes/sentryWebhook'));
// Sentry tunnel is mounted ABOVE in the middleware block. See its
// comment for the body-parser-bypass rationale.
// requireAuth BEFORE aiLimiter so the limiter keys per USER, not per IP — the
// assistant routes run their own requireAuth too (harmless re-check), but the
// limiter needs req.user populated here or co-located students behind one campus
// NAT would share a single 40/hr bucket and throttle each other.
app.use('/assistant', require('./middleware/auth').requireAuth, require('./middleware/rateLimits').aiLimiter, require('./routes/assistant'));
app.use('/offers',    require('./routes/offers'));
app.use('/stories',   require('./routes/stories'));
app.use('/best-roommate', require('./routes/votes'));
app.use('/plaid',    require('./routes/plaid'));
app.use('/house-rules', require('./routes/houseRules'));
app.use('/identity', require('./routes/identity'));
const sharedReviews = require('./routes/sharedReviews');
app.use('/landlord-reviews', sharedReviews.landlordRouter);
app.use('/building-reviews', sharedReviews.buildingRouter);

// Health check. `commit` echoes the deployed git SHA (Railway injects
// RAILWAY_GIT_COMMIT_SHA at build time) so a single curl confirms which
// build is actually live — the hardcoded `version` couldn't. Falls back
// to 'local' off-Railway.
const DEPLOY_COMMIT = (process.env.RAILWAY_GIT_COMMIT_SHA || 'local').slice(0, 7);

// A live Node process is NOT the same as a healthy service: the DB/auth layer
// can be failing while the process happily serves. So /health does a trivial
// read-only round-trip to Postgres and returns 503 when it can't — that's the
// class of outage (DB unreachable / connection pool wedged) UptimeRobot must
// page on. Kept unauthenticated (UptimeRobot hits it anonymously) and never
// writes. NB: this does NOT catch app-logic bugs (e.g. an auth handler that
// 400s while the DB is fine) — the Sentry backend_outage alert is the
// complementary tripwire for that case.
const HEALTH_DB_TIMEOUT_MS = 2500;
app.get('/health', async (req, res) => {
  const base = {
    version: '1.0.0',
    commit: DEPLOY_COMMIT,             // deployed git SHA — confirms which build is live
    uptime: process.uptime(),          // seconds since this instance booted
    timestamp: new Date().toISOString(),
  };
  // Race SELECT 1 against a short timeout so a hung connection returns 503 fast
  // instead of hanging the health check itself (the pool's connectionTimeout
  // only bounds *acquiring* a connection, not a query on an open-but-stuck one).
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`db health timeout after ${HEALTH_DB_TIMEOUT_MS}ms`)), HEALTH_DB_TIMEOUT_MS);
    if (timer.unref) timer.unref();    // don't keep the event loop alive for this
  });
  try {
    await Promise.race([pool.query('SELECT 1'), timeout]);
    clearTimeout(timer);
    res.status(200).json({ ok: true, status: 'ok', db: 'up', ...base });
  } catch (err) {
    clearTimeout(timer);               // stop the loser from later rejecting unhandled
    console.error('[health] DB check failed → 503:', err.message);
    res.status(503).json({ ok: false, status: 'degraded', db: 'down', ...base });
  }
});


// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Global error handler. Sentry (when enabled) gets a copy of every
// unhandled exception via captureError; we still log and respond 500
// regardless so the request always completes.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  sentry.captureError(err, { path: req.path, method: req.method });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Push notifications helper ─────────────────────────────────────────────
async function sendPushToUser(userId, { title, body, data }) {
  const { rows } = await pool.query(
    'SELECT token FROM push_tokens WHERE user_id = $1',
    [userId]
  );

  for (const row of rows) {
    // Expo push notification service
    await fetch('https://exp.host/--/api/v2/push/send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to:    row.token,
        title,
        body,
        data,
        sound: 'default',
        badge: 1,
      }),
    }).catch(() => {});
  }
}

// Export for use in routes
app.set('io', io);
app.set('sendPushToUser', sendPushToUser);
app.set('isUserOnline', isUserOnline);

// ── Schema bootstrap ──────────────────────────────────────────────────────
// Apply src/db/migrate_missing.sql in the background AFTER server.listen
// resolves. Every statement in that file uses idempotent shapes (CREATE
// TABLE IF NOT EXISTS, ALTER TABLE ADD COLUMN IF NOT EXISTS, CREATE INDEX
// IF NOT EXISTS, etc.) so re-running on each boot does nothing on a
// healthy database and adds missing pieces on a stale one.
//
// History: previous workflow was "psql -f migrate_missing.sql by hand
// after each backend deploy" — easy to forget, and exactly what caused
// the 2FA columns to ship with no working /setup endpoint (the route
// shipped, the columns didn't). Auto-applying on boot removes that
// footgun.
//
// CRITICAL: this runs AFTER listen, not before. A previous version
// awaited the bootstrap before calling server.listen() and the
// migration's wall-clock time pushed past Railway's healthcheck window,
// which then rolled the deploy back. The bug it caused was worse than
// the bug it was meant to fix. We now:
//   1. Start listening immediately so /health responds within ms.
//   2. Run the bootstrap in the background.
//   3. Log success / failure loudly to Railway logs — does NOT exit,
//      because a stale schema only breaks the routes that touch the
//      missing columns, and the rest of the API should keep serving.
//      A hard exit would take everything down for a bootstrap problem
//      that the user-visible failure already pinpoints.
async function bootstrapSchemaAsync() {
  const fs   = require('fs');
  const path = require('path');
  const sqlPath = path.resolve(__dirname, 'db', 'migrate_missing.sql');
  if (!fs.existsSync(sqlPath)) {
    console.warn('[bootstrap] migrate_missing.sql not found at', sqlPath, '— skipping');
    return;
  }
  const sql = fs.readFileSync(sqlPath, 'utf8');

  // Split on top-level semicolons, ignoring those inside string literals
  // and SQL line comments. We can't run the whole file as one pool.query
  // because a single failing statement aborts every following statement
  // in the batch — that's how the bootstrap that was supposed to add
  // the 2FA columns (last 3 lines of the file) silently never ran:
  // an earlier `CREATE INDEX … ON messages(…, created_at DESC)`
  // statement choked because `messages` exists in prod without
  // `created_at`, and the batch failed before reaching the new ALTERs.
  //
  // Split into individual statements, dollar-quote aware. PL/pgSQL bodies use
  // $$…$$ (or $tag$…$tag$), and the semicolons inside them are NOT statement
  // terminators — splitting on them shredded update_updated_at() into fragments
  // that failed on every boot. Extracted + unit-tested in
  // src/lib/splitSqlStatements.js so this stays correct.
  const { splitSqlStatements: splitStatements } = require('./lib/splitSqlStatements');

  const statements = splitStatements(sql);
  console.log(`[bootstrap] applying ${statements.length} statements from migrate_missing.sql (background)…`);

  let ok = 0, failed = 0;
  for (let idx = 0; idx < statements.length; idx++) {
    const stmt = statements[idx];
    try {
      await pool.query(stmt);
      ok++;
    } catch (err) {
      failed++;
      // One line per failure — enough for Railway logs to point at the
      // offending statement. We deliberately don't bail; the next
      // statement may still be useful (e.g. the trailing 2FA ALTERs
      // we just added) and the rest of the API stays up regardless.
      const preview = stmt.replace(/\s+/g, ' ').slice(0, 120);
      console.error(`[bootstrap] statement ${idx + 1} FAILED: ${err.message} (preview: ${preview}…)`);
    }
  }
  console.log(`[bootstrap] done — ${ok} ok, ${failed} failed`);
  if (failed > 0) {
    sentry.captureMessage?.(`bootstrap had ${failed} failing statement(s)`, 'warning');
  }

  // Make the demo pool live-matchable (idempotent, demo-only). Runs after the
  // schema migration so quiz_answers exists. Never blocks the API — its own
  // try/catch keeps a seed error from affecting the running server.
  try {
    const { seedDemoMatchable } = require('./db/seedDemoMatchable');
    const r = await seedDemoMatchable();
    console.log(`[bootstrap] demo-matchable seed: ${r.seededAnswers} answers seeded, ${r.scoredPairs} founder↔demo pairs scored`);
  } catch (err) {
    console.error('[bootstrap] demo-matchable seed failed:', err.message);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 HavenIQ API running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`
    + ` (railway: ${process.env.RAILWAY_ENVIRONMENT || 'n/a'})`);
  // Print any live auth bypasses (demo session / .edu relax / fixed OTP) so
  // they are visible in the deploy log rather than silently enabled — and so a
  // misconfiguration on prod is loud. They are refused on prod regardless.
  require('./lib/stagingGuard').logStagingBypasses();
  // Echo the resolved DB HOST (never credentials) so a load-test operator can
  // confirm at a glance that a staging instance is pointed at the STAGING
  // Postgres — not production. Host only, parsed from DATABASE_URL.
  let dbHost = '(DATABASE_URL unset)';
  try { if (process.env.DATABASE_URL) dbHost = new URL(process.env.DATABASE_URL).host; } catch { dbHost = '(unparseable DATABASE_URL)'; }
  console.log(`   Database host: ${dbHost}`);
  console.log(`   Health check: http://localhost:${PORT}/health\n`);
  // Fire the bootstrap after listen — Railway's healthcheck sees a live
  // /health within ms and won't roll back if the migration is slow.
  bootstrapSchemaAsync();

  // Self-heal loop: periodically repair completed-quiz users left with no
  // personality_profiles row (a failed derivation → degraded clinical-only
  // matches). Bounded per run so a backlog can't spike Anthropic cost;
  // idempotent (healed users drop out of the query); best-effort. Runs ~90s
  // after boot (let the schema settle), then every 3h. The same function is
  // exposed at POST /bot-admin/heal-personalities for cron/manual triggering.
  let healInFlight = false;
  const runPersonalityHeal = () => {
    if (healInFlight) return; // never overlap runs — each fires Anthropic calls
    healInFlight = true;
    try {
      const { healMissingPersonalities } = require('./routes/quiz');
      healMissingPersonalities({ limit: 20 })
        .then(s => { if (s.missing) console.log('[heal] personalities:', JSON.stringify(s)); })
        .catch(err => console.error('[heal] sweep failed:', err.message))
        .finally(() => { healInFlight = false; });
    } catch (err) {
      healInFlight = false;
      console.error('[heal] could not start sweep:', err.message);
    }
  };
  setTimeout(runPersonalityHeal, 90 * 1000);
  setInterval(runPersonalityHeal, 3 * 60 * 60 * 1000).unref?.();

  // Deep-matching gate sweep: re-fit + re-certify the per-dimension shapes (#2/#6)
  // and the LLM text-insight constructs (#5) from accrued pairing_outcomes, then
  // refresh the scorer caches. DB-only and cheap — NO Anthropic calls here (LLM
  // EXTRACTION stays on bio-change + the bot endpoint). Inert until real move-in /
  // room-change outcomes exist (certifies nothing → scoring stays today). Best-
  // effort, non-overlapping. Runs ~5 min after boot, then daily. Same work is at
  // POST /bot-admin/train-dimension-models + /train-text-insights for manual runs.
  let trainInFlight = false;
  const runGateTraining = async () => {
    if (trainInFlight) return;
    trainInFlight = true;
    try {
      const dim = require('./services/dimensionModel');
      const ti = require('./services/textInsight');
      const a = await dim.trainDimensionModels().catch(e => { console.error('[gate-train] dims failed:', e.message); return []; });
      await dim.loadCertifiedModels({ force: true }).catch(() => {});
      const b = await ti.trainFeatures().catch(e => { console.error('[gate-train] text-insight failed:', e.message); return []; });
      await ti.loadCertifiedModels({ force: true }).catch(() => {});
      const certDims = a.filter(s => s && s.certified).length;
      const certTi = b.filter(s => s && s.certified).length;
      if (certDims || certTi) console.log(`[gate-train] certified dims=${certDims} constructs=${certTi}`);
    } catch (err) {
      console.error('[gate-train] sweep could not start:', err.message);
    } finally {
      trainInFlight = false;
    }
  };
  setTimeout(runGateTraining, 5 * 60 * 1000);
  setInterval(runGateTraining, 24 * 60 * 60 * 1000).unref?.();

  // Housing-timing ingest: download the PUBLIC Zillow Research ZORI rent CSV and
  // recompute each metro's seasonal "best time to lock in". LEGAL (published
  // aggregate data, never a listing-page scrape). Best-effort, non-overlapping;
  // a download/parse failure just leaves the last good data in place. Runs ~10
  // min after boot, then weekly. Manual trigger: POST /housing/ingest-timing.
  let housingInFlight = false;
  const runHousingIngest = async () => {
    if (housingInFlight) return;
    housingInFlight = true;
    try {
      const r = await require('./services/housingTiming').ingestZori();
      console.log('[housing-ingest]', JSON.stringify(r));
      // Watch loop: right AFTER a source refresh, recompute coverage across all
      // schools, diff vs the last snapshot, store the report, and page Discord
      // ONLY on a flagged regression/anomaly transition. Routine refresh = silent.
      // Best-effort; a diff failure never affects the ingest. GET /ops/data-diff.
      try {
        const d = await require('./services/coverageDiff').runCoverageDiff();
        console.log('[coverage-diff]', JSON.stringify(d));
      } catch (e) {
        console.error('[coverage-diff] could not run:', e.message);
      }
    } catch (err) {
      console.error('[housing-ingest] could not start:', err.message);
    } finally {
      housingInFlight = false;
    }
  };
  setTimeout(runHousingIngest, 10 * 60 * 1000);
  setInterval(runHousingIngest, 7 * 24 * 60 * 60 * 1000).unref?.();

  // ── Listing collector ────────────────────────────────────────────
  // Continuous, not on demand: a new posting should reach the moderation queue
  // on its own, not when someone remembers to run a script.
  //
  // Targets are configured, not compiled, so adding a campus is an env change
  // rather than a deploy:
  //
  //     COLLECT_TARGETS=craigslist:lax:UCLA;craigslist:sfo:UC Berkeley
  //
  // Separated by ';' because school names contain commas — the canonical name
  // for UCLA is "University of California, Los Angeles", and a comma-separated
  // list truncates it to "University of California", a school no student has.
  //
  // Unset means the collector stays dark, which is the right default for a job
  // that fetches from someone else's site.
  //
  // Each cycle reads today's sitemap, drops every posting already held WITHOUT
  // fetching it (collector.filterNew), and walks only what is new at one
  // request per second. PER_RUN caps a cycle so it stays bounded and polite;
  // at 150 per half hour that is 7,200 a day, comfortably above what a single
  // region actually publishes.
  //
  // Everything it collects lands as 'pending'. This job cannot publish.
  const { parseCollectTargets } = require('./services/collectTargets');
  const { targets: COLLECT_TARGETS, rejected: COLLECT_REJECTED } =
    parseCollectTargets(process.env.COLLECT_TARGETS);
  // Say what was thrown away. A target that fails to parse used to vanish in
  // silence, so a typo looked exactly like a campus with no listings.
  if (COLLECT_REJECTED.length) {
    console.error('[collector] ignoring malformed target(s):', COLLECT_REJECTED.join(' | '));
  }

  const COLLECT_PER_RUN = Number(process.env.COLLECT_PER_RUN || 150);
  // 100 re-checks a cycle is under two minutes at one request per second, and
  // sweeps a few hundred listings roughly every couple of hours — so the
  // oldest thing a student can see is never stale by more than that.
  const RECHECK_PER_RUN = Number(process.env.RECHECK_PER_RUN || 100);
  const COLLECT_EVERY_MS = Number(process.env.COLLECT_EVERY_MIN || 30) * 60 * 1000;

  let collectInFlight = false;
  const runCollector = async () => {
    if (collectInFlight || !COLLECT_TARGETS.length) return;
    collectInFlight = true;
    try {
      const { collect } = require('./services/collector');
      const SOURCES = {
        craigslist: require('./services/sources/craigslist'),
        uloop:      require('./services/sources/uloop'),
      };
      for (const t of COLLECT_TARGETS) {
        const adapter = SOURCES[t.source];
        if (!adapter) { console.error('[collector] unknown source', t.source); continue; }
        try {
          const stats = await collect(adapter, {
            region: t.region, schoolNear: t.school,
            limit: COLLECT_PER_RUN,
            log: () => {},               // per-posting chatter stays out of the logs
          });
          console.log('[collector]', JSON.stringify({ ...t, ...stats }));
          // A source that starts refusing us is worth a human knowing about.
          // The collector does not try again wearing a different hat.
          if (stats.blocked > 0) console.error('[collector] BLOCKED by', t.source, '-', stats.blocked, 'request(s) refused');
        } catch (e) {
          console.error('[collector] target failed', JSON.stringify(t), e.message);
        }
      }

      // Re-read what we already hold, and retire what the source has dropped.
      //
      // Runs after collecting, on the same cycle, because it is the other half
      // of the same job: adding new listings keeps the tab full, and this keeps
      // it honest. Without it the app drifts into advertising flats that were
      // let weeks ago — which, from a student's side, is exactly what a fake
      // listing looks like.
      try {
        const { recheckListings } = require('./services/recheck');
        const { politeFetch } = require('./services/collector');
        const seen = await recheckListings({
          politeFetch,
          limit: RECHECK_PER_RUN,
          log: () => {},              // per-listing chatter stays out of the logs
        });
        if (seen.checked) console.log('[recheck]', JSON.stringify(seen));
        if (seen.blocked > 0) console.error('[recheck] BLOCKED on', seen.blocked, 'check(s) — listings left live, not retired');
      } catch (err) {
        console.error('[recheck] failed:', err.message);
      }
    } catch (err) {
      console.error('[collector] could not start:', err.message);
    } finally {
      collectInFlight = false;
    }
  };
  if (COLLECT_TARGETS.length) {
    console.log('[collector] watching', COLLECT_TARGETS.map(t => `${t.source}:${t.region}->${t.school}`).join(', '));
    setTimeout(runCollector, 4 * 60 * 1000);          // after boot settles
    setInterval(runCollector, COLLECT_EVERY_MS).unref?.();
  }

  // ── Outcome-learning 24/7 wiring (Phases 1–4) ──────────────────────────────
  // Two always-on jobs ride this existing scheduler; the ONE hard stop —
  // committing weight changes to the live matching model — stays human-gated.
  // Both are best-effort, non-overlapping, and INERT until outcomes accrue
  // (no data → no snapshot rows, no proposals → scoring stays today, bit-for-bit).

  // (a) Calibration recompute + quality snapshot: refresh the prediction-vs-
  // reality curve, Brier, AUC, monotonicity, and the public headline multiple so
  // `Does this actually work?` and the metrics route are always current. DB-only,
  // no LLM. Runs ~15 min after boot, then every 6h.
  let calibInFlight = false;
  const runCalibrationSnapshot = async () => {
    if (calibInFlight) return;
    calibInFlight = true;
    try {
      const wl = require('./routes/weightLearning');
      const metrics = require('./services/calibrationMetrics');
      const snapshots = require('./services/learningSnapshots');
      const { calibration, points } = await wl._readCalibration();
      if (!calibration.ok) return; // no data yet — record nothing (honest)
      const headline = metrics.publicHeadline(calibration);
      await snapshots.record({
        totalSample: calibration.totalSample,
        brier: metrics.brierScore(points),
        auc: metrics.auc(points),
        monotonic: metrics.isMonotonic(calibration.bands),
        headlineMult: headline.ok ? headline.multiple : null,
        bands: calibration.bands,
      });
      console.log(`[calibration] snapshot n=${calibration.totalSample} monotonic=${metrics.isMonotonic(calibration.bands)}`);
    } catch (err) {
      console.error('[calibration] snapshot could not start:', err.message);
    } finally {
      calibInFlight = false;
    }
  };
  setTimeout(runCalibrationSnapshot, 15 * 60 * 1000);
  setInterval(runCalibrationSnapshot, 6 * 60 * 60 * 1000).unref?.();

  // (b) The analyst: label outcomes, run the regularized stats (global +
  // per-school), draft a plain-English summary, and enqueue READY proposals for
  // human approval. Below the readiness gate it enqueues nothing. One small LLM
  // call only when a NEW proposal is created (deduped) — no always-on burn. Runs
  // ~20 min after boot, then daily.
  let analystInFlight = false;
  const runWeightAnalyst = async () => {
    if (analystInFlight) return;
    analystInFlight = true;
    try {
      const r = await require('./services/weightAnalyst').runAnalyst({ enqueue: true });
      if (r.enqueued.length) console.log('[weight-analyst]', JSON.stringify(r));
    } catch (err) {
      console.error('[weight-analyst] sweep could not start:', err.message);
    } finally {
      analystInFlight = false;
    }
  };
  setTimeout(runWeightAnalyst, 20 * 60 * 1000);
  setInterval(runWeightAnalyst, 24 * 60 * 60 * 1000).unref?.();

  // ── Watch loop: self-reporting health monitor ──────────────────────────────
  // Poll /health (deep DB check + deployed SHA), record each result to a small
  // rolling in-memory ring, and page the human (signal:backend_outage) ONLY on a
  // debounced transition into unhealthy — a single blip never pages. Clears on
  // recovery. GET /ops/health-history exposes the ring so status self-reports.
  // Best-effort + never overlaps; a poll failure is itself just an unhealthy
  // observation. First poll ~30s after boot (past the migration window), then
  // every 60s.
  let watchInFlight = false;
  const runHealthWatch = async () => {
    if (watchInFlight) return;
    watchInFlight = true;
    try {
      const transition = await require('./services/healthWatchRunner').pollOnce();
      if (transition) console.log(`[watch] transition → ${transition}`);
    } catch (err) {
      console.error('[watch] poll could not start:', err.message);
    } finally {
      watchInFlight = false;
    }
  };
  setTimeout(runHealthWatch, 30 * 1000);
  setInterval(runHealthWatch, 60 * 1000).unref?.();

  // ── Grow loop: autonomous lifecycle messaging ──────────────────────────────
  // Segment users by REAL state and send the matching frozen template with no
  // per-batch approval — guardrails replace the human gate: kill switch
  // (WATCH_LIFECYCLE_ENABLED, default OFF), a 7-day per-user frequency cap, and
  // a volume circuit breaker that PAUSES + pages Discord if a run would blast
  // more than WATCH_LIFECYCLE_MAX_FRACTION of active users. Every send + run is
  // audited (GET /ops/lifecycle-log). Best-effort, non-overlapping. Runs ~25 min
  // after boot, then daily. Inert until the kill switch is flipped on.
  let lifecycleInFlight = false;
  const runLifecycleJob = async () => {
    if (lifecycleInFlight) return;
    lifecycleInFlight = true;
    try {
      const r = await require('./services/lifecycleSender').runLifecycle();
      if (r.sent || r.paused) console.log('[lifecycle]', JSON.stringify(r));
    } catch (err) {
      console.error('[lifecycle] run could not start:', err.message);
    } finally {
      lifecycleInFlight = false;
    }
  };
  setTimeout(runLifecycleJob, 25 * 60 * 1000);
  setInterval(runLifecycleJob, 24 * 60 * 60 * 1000).unref?.();

  // ── Grow loop: weekly growth digest (informational only) ───────────────────
  // Reads REAL numbers (signups, quiz completions, matches, connects, referrals),
  // computes week-over-week deltas + the activation funnel, and drafts a founder
  // digest (LLM writes the narrative around DB numbers; deterministic fallback).
  // Emails via Resend + GET /ops/growth-digest. Takes NO action, sends nothing to
  // users — so no circuit breaker; a kill switch (WATCH_DIGEST_ENABLED, default
  // OFF) gates when it starts. Best-effort, non-overlapping. First ~35 min after
  // boot, then weekly.
  let digestInFlight = false;
  const runGrowthDigest = async () => {
    if (digestInFlight) return;
    digestInFlight = true;
    try {
      const r = await require('./services/growthDigest').runDigest();
      if (r.enabled) console.log('[growth-digest]', JSON.stringify({ emailed: r.emailed, source: r.source, biggestDrop: r.biggestDrop }));
    } catch (err) {
      console.error('[growth-digest] run could not start:', err.message);
    } finally {
      digestInFlight = false;
    }
  };
  setTimeout(runGrowthDigest, 35 * 60 * 1000);
  setInterval(runGrowthDigest, 7 * 24 * 60 * 60 * 1000).unref?.();

  // ── Safety-report backlog digest — the trust-&-safety nudge ────────────────
  // Individual reports already email the founder in real time; this once-daily
  // job counts reports still sitting in `open` and pings the ops Discord so a
  // backlog can't quietly rot because nobody opened /admin/safety (triage is a
  // bus-factor of one). Fires ONLY when the queue is non-empty and a Discord
  // hook is set — read-only, no action, sends nothing to users. No kill switch:
  // unlike the growth/lifecycle digests it never touches a user, and it
  // self-silences on a clean queue. First run ~10 min after boot, then daily.
  let safetyDigestInFlight = false;
  const runSafetyDigest = async () => {
    if (safetyDigestInFlight) return;
    safetyDigestInFlight = true;
    try {
      const r = await require('./services/safetyDigest').runSafetyDigest();
      if (r.pinged) console.log('[safety-digest]', JSON.stringify(r));
    } catch (err) {
      console.error('[safety-digest] run could not start:', err.message);
    } finally {
      safetyDigestInFlight = false;
    }
  };
  setTimeout(runSafetyDigest, 10 * 60 * 1000);
  setInterval(runSafetyDigest, 24 * 60 * 60 * 1000).unref?.();
});

module.exports = { app, server };
