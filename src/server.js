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
const rateLimit  = require('express-rate-limit');
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

const corsOrigin = allowedOrigins.includes('*')
  ? true  // express-cors treats `true` as "reflect request origin" — works for browsers but doesn't accept credentials with `*` literal
  : (origin, cb) => {
      // Same-origin / curl requests have no Origin header — let them through.
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      // Our own Cloudflare Pages aliases — always trusted, regardless of CLIENT_URL.
      if (PAGES_DEV_HOST.test(origin)) return cb(null, true);
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

// ── Socket.io (real-time messaging) ──────────────────────────────────────
//
// ⚠️  CURRENTLY UNUSED IN PRODUCTION (as of 2026-05-17). The web client at
// app.haveniq.org goes through the HTTP messaging path only (see
// stores/matchStore.ts sendMessage). The socket.io handler below is left
// in place because:
//   1. The helper `sendPushToUser` (which IS used by HTTP routes) lives in
//      this file alongside the socket setup,
//   2. A future native iOS/Android build can connect for real-time delivery
//      without re-architecting the server.
//
// If we ever wire the web client to use socket.io, audit for duplicate
// message rows — the HTTP POST and the `send_message` socket event would
// BOTH insert into `messages`, which would silently double messages.
const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
  },
});

// Socket auth middleware
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) throw new Error('No token');

    const jwt    = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { rows } = await pool.query(
      'SELECT id, first_name FROM users WHERE id = $1',
      [decoded.userId]
    );
    if (!rows[0]) throw new Error('User not found');

    socket.userId    = rows[0].id;
    socket.firstName = rows[0].first_name;
    next();
  } catch (err) {
    next(new Error('Authentication failed'));
  }
});

io.on('connection', (socket) => {
  console.log(`⚡ Socket connected: ${socket.firstName || socket.userId}`);

  // Join personal room (for DMs)
  socket.join(`user:${socket.userId}`);

  // Join a conversation room
  socket.on('join_conversation', (conversationId) => {
    socket.join(`conv:${conversationId}`);
  });

  // Send a message
  socket.on('send_message', async (data) => {
    const { conversationId, body } = data || {};
    if (!conversationId || !body?.trim()) return;
    // Same 10K cap as the HTTP /:conversationId route. Without this a
    // socket-connected client could bypass the HTTP-side validation.
    if (body.length > 10000) return;

    try {
      // Verify this user belongs to the conversation
      const { rows: convRows } = await pool.query(
        'SELECT user_a, user_b FROM conversations WHERE id = $1 AND (user_a = $2 OR user_b = $2)',
        [conversationId, socket.userId]
      );
      if (!convRows[0]) return;

      // Save to DB
      const { rows } = await pool.query(
        'INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1, $2, $3) RETURNING *',
        [conversationId, socket.userId, body.trim()]
      );

      const message = rows[0];

      // Broadcast to everyone in the conversation
      io.to(`conv:${conversationId}`).emit('new_message', {
        ...message,
        senderName: socket.firstName,
      });

      // Push notification to the other user (fire-and-forget)
      const otherUserId = convRows[0].user_a === socket.userId
        ? convRows[0].user_b
        : convRows[0].user_a;

      sendPushToUser(otherUserId, {
        title: `${socket.firstName} sent a message`,
        body: body.trim().slice(0, 80),
        data: { screen: 'thread', conversationId },
      }).catch(err => console.error('[push] socket message send failed:', err));

    } catch (err) {
      console.error('send_message error:', err);
    }
  });

  // Typing indicator
  socket.on('typing', ({ conversationId, isTyping }) => {
    socket.to(`conv:${conversationId}`).emit('user_typing', {
      userId: socket.userId,
      isTyping,
    });
  });

  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.userId}`);
  });
});

// ── Express middleware ────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: corsOrigin,
  // Credentials only meaningful when origin is reflected (not '*'). We
  // don't use cookies (bearer-token auth) so this is mostly defensive
  // hygiene for the day someone adds them.
  credentials: !allowedOrigins.includes('*'),
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
}));

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/auth',     require('./routes/auth'));
// Mount /auth/2fa AFTER /auth so the dedicated twoFactor router owns
// /setup, /verify-setup, /disable, and the /challenge endpoint that
// finishes a 2FA-required sign-in.
app.use('/auth/2fa', require('./routes/twoFactor'));
app.use('/users',    require('./routes/users'));
app.use('/quiz',     require('./routes/quiz'));
app.use('/matches',  require('./routes/matches'));
app.use('/matches',  require('./routes/matchOfTheDay'));  // /matches/today + /matches/today/action
app.use('/matches',  require('./routes/matchedMoment'));  // /matches/matched/:userId
app.use('/daily',    require('./routes/dailyDiscovery')); // /daily/today + /daily/today/answer
app.use('/',         require('./routes/activityPulse'));  // /activity-pulse
app.use('/messages', require('./routes/messages'));
app.use('/telemetry', require('./routes/telemetry'));
app.use('/reviews',  require('./routes/reviews'));
app.use('/pulses',   require('./routes/pulses'));
app.use('/checklists', require('./routes/checklists'));
app.use('/groups',   require('./routes/groups'));
app.use('/search',   require('./routes/search'));
app.use('/housing',  require('./routes/housing'));
app.use('/premium',  require('./routes/premium'));
app.use('/admin',    require('./routes/admin'));
app.use('/admin/safety', require('./routes/adminSafety'));
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
app.use('/', require('./routes/matchOutcomes'));      // /bot-admin/pending-checkins + summary
// Tier 3 Sentry webhook — when Sentry detects a new issue, it POSTs here
// within ~5-10 seconds. We triage immediately, post to Discord, and
// dispatch the auto-fix workflow without waiting for the every-15-min
// cron. End-to-end: error → production fix in ~5-7 min for safe bugs.
app.use('/sentry', require('./routes/sentryWebhook'));
// Sentry tunnel is mounted ABOVE in the middleware block. See its
// comment for the body-parser-bypass rationale.
app.use('/assistant', require('./routes/assistant'));
app.use('/offers',    require('./routes/offers'));
app.use('/stories',   require('./routes/stories'));
app.use('/best-roommate', require('./routes/votes'));
app.use('/plaid',    require('./routes/plaid'));
app.use('/house-rules', require('./routes/houseRules'));
app.use('/identity', require('./routes/identity'));
const sharedReviews = require('./routes/sharedReviews');
app.use('/landlord-reviews', sharedReviews.landlordRouter);
app.use('/building-reviews', sharedReviews.buildingRouter);

// Health check
app.get('/health', (req, res) => res.json({
  status: 'ok',
  version: '1.0.0',
  timestamp: new Date().toISOString(),
}));


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
  // Splitter is intentionally conservative — strips `--` line comments
  // and respects single-quoted strings (with '' escape). It's not a
  // full SQL parser; the bootstrap file is checked into the repo so
  // we control what shapes it contains. If a future statement uses
  // dollar-quoted strings ($$...$$) or `/* */` block comments, this
  // function needs an upgrade.
  function splitStatements(src) {
    const out = [];
    let buf = '';
    let inSingleQuote = false;
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      // -- line comment
      if (!inSingleQuote && c === '-' && n === '-') {
        const end = src.indexOf('\n', i);
        i = end === -1 ? src.length : end + 1;
        continue;
      }
      if (c === "'") {
        // SQL '' is an escaped single quote inside a string
        if (inSingleQuote && n === "'") { buf += "''"; i += 2; continue; }
        inSingleQuote = !inSingleQuote;
        buf += c; i++; continue;
      }
      if (c === ';' && !inSingleQuote) {
        const stmt = buf.trim();
        if (stmt) out.push(stmt);
        buf = '';
        i++; continue;
      }
      buf += c; i++;
    }
    const tail = buf.trim();
    if (tail) out.push(tail);
    return out;
  }

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
}

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 HavenIQ API running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Health check: http://localhost:${PORT}/health\n`);
  // Fire the bootstrap after listen — Railway's healthcheck sees a live
  // /health within ms and won't roll back if the migration is slow.
  bootstrapSchemaAsync();
});

module.exports = { app, server };
