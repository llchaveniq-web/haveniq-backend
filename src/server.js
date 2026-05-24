require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const pool       = require('./db/pool');
const { requireAuth }  = require('./middleware/auth');
const sentry            = require('./utils/sentry');

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
const corsOrigin = allowedOrigins.includes('*')
  ? true  // express-cors treats `true` as "reflect request origin" — works for browsers but doesn't accept credentials with `*` literal
  : (origin, cb) => {
      // Same-origin / curl requests have no Origin header — let them through.
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: ${origin} not in allowed list`));
    };

// Sentry — opt-in error monitoring. No-op unless SENTRY_DSN env var is
// set AND @sentry/node is installed. See utils/sentry.js for setup
// instructions. Initialize as early as possible so initialization
// errors elsewhere still get captured.
sentry.tryInit();

const app    = express();
app.set('trust proxy', 1); // Required for Railway / reverse proxies
const server = http.createServer(app);

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
app.use('/users',    require('./routes/users'));
app.use('/quiz',     require('./routes/quiz'));
app.use('/matches',  require('./routes/matches'));
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

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 HavenIQ API running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Health check: http://localhost:${PORT}/health\n`);
});

module.exports = { app, server };
