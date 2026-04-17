require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const pool       = require('./db/pool');
const { requireAuth } = require('./middleware/auth');

const app    = express();
app.set('trust proxy', 1); // Required for Railway / reverse proxies
const server = http.createServer(app);

// ── Socket.io (real-time messaging) ──────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || '*',
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
    const { conversationId, body } = data;
    if (!conversationId || !body?.trim()) return;

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
      }).catch(() => {});

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
  origin: process.env.CLIENT_URL || '*',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
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

// Health check
app.get('/health', (req, res) => res.json({
  status: 'ok',
  version: '1.0.0',
  timestamp: new Date().toISOString(),
}));

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
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
