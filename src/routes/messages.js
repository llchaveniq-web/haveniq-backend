const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, refuseBanned } = require('../middleware/auth');
const suspicious = require('../middleware/suspiciousActivity');
const analytics = require('../services/analytics');
const { screenMessage, CRISIS_SUPPORT } = require('../lib/contentFilter');
const { sendNewMessageEmail } = require('../services/email');
const { isDemoEmail, notDemo } = require('../lib/demoFilter');
const { isFounderUser } = require('../utils/founders');
const { recordPairingEvent } = require('../services/pairingOutcomes');

// Email the recipient on a NEW message — but only the FIRST unread one in a
// conversation (they were caught up), so a burst of messages emails once, not
// per-message. The whole production app is web, where push tokens are never
// registered, so without this a messaged student who isn't on the site never
// knows. Best-effort; never blocks send; skips seeded demo accounts.
async function maybeEmailNewMessage(conversationId, recipientId, senderFirstName) {
  try {
    const { rows: unread } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM messages
        WHERE conversation_id = $1 AND sender_id <> $2 AND read = FALSE`,
      [conversationId, recipientId],
    );
    // 1 == only the message we just inserted is unread → recipient was caught
    // up → this is a fresh notification moment. >1 → already had unread → skip.
    if (!unread[0] || unread[0].n !== 1) return;
    const { rows } = await pool.query(
      'SELECT email, first_name FROM users WHERE id = $1',
      [recipientId],
    );
    const r = rows[0];
    if (!r || !r.email) return;
    if (isDemoEmail(r.email)) return;
    await sendNewMessageEmail(r.email, r.first_name || 'there', senderFirstName || 'Your match', recipientId);
  } catch (err) {
    console.error('[message email] send failed:', err);
  }
}

// ── Message moderation flags (self-migrating audit table) ───────────────────
// Records every message the content filter blocks or flags, so the founder can
// review patterns and repeat offenders. Best-effort: a logging failure must
// never break message delivery.
let flagsTableReady = false;
async function ensureFlagsTable() {
  if (flagsTableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_flags (
      id              BIGSERIAL PRIMARY KEY,
      conversation_id TEXT,
      sender_id       TEXT,
      recipient_id    TEXT,
      action          TEXT NOT NULL,
      category        TEXT,
      excerpt         TEXT,
      message_id      TEXT,
      reviewed        BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_message_flags_created ON message_flags (created_at DESC)`);
  flagsTableReady = true;
}
async function logMessageFlag(f) {
  try {
    await ensureFlagsTable();
    await pool.query(
      `INSERT INTO message_flags (conversation_id, sender_id, recipient_id, action, category, excerpt, message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        String(f.conversationId ?? ''),
        String(f.senderId ?? ''),
        String(f.recipientId ?? ''),
        f.action,
        f.category ?? null,
        (f.excerpt ?? '').slice(0, 240),
        f.messageId != null ? String(f.messageId) : null,
      ],
    );
  } catch (e) {
    console.error('[message_flags] log failed:', e.message);
  }
}

// ── GET /messages/conversations ───────────────────────────────────────────
// All conversations for the current user with last message
router.get('/conversations', requireAuth, async (req, res) => {
  try {
    // Demo/bot threads (the seeded founder↔demo conversation) stay out of the
    // inbox unless DEMO_FEED=true is set for an investor pitch — same gate as
    // the match feed. Real students never have demo threads, but this keeps the
    // founder's own inbox clean by default.
    const includeDemos = isFounderUser(req.user) && process.env.DEMO_FEED === 'true';
    const demoFilter   = includeDemos ? '' : `AND ${notDemo('u.email')}`;
    const { rows } = await pool.query(
      `SELECT
         c.id AS conversation_id,
         CASE WHEN c.user_a = $1 THEN c.user_b ELSE c.user_a END AS other_user_id,
         u.first_name, u.last_name, u.school, u.photo_url, u.is_verified, u.last_active_at,
         m.body AS last_message,
         m.created_at AS last_message_at,
         m.sender_id AS last_sender_id,
         (
           SELECT COUNT(*) FROM messages
           WHERE conversation_id = c.id
             AND sender_id != $1
             AND read = FALSE
         ) AS unread_count,
         cs.score AS compat_score
       FROM conversations c
       JOIN users u ON u.id = (
         CASE WHEN c.user_a = $1 THEN c.user_b ELSE c.user_a END
       )
       LEFT JOIN LATERAL (
         SELECT body, created_at, sender_id FROM messages
         WHERE conversation_id = c.id
         ORDER BY created_at DESC LIMIT 1
       ) m ON TRUE
       LEFT JOIN compatibility_scores cs ON (
         (cs.user_a = $1 AND cs.user_b = u.id) OR
         (cs.user_b = $1 AND cs.user_a = u.id)
       )
       WHERE (c.user_a = $1 OR c.user_b = $1)
         -- Soft-disconnected ("unmatched") threads drop off both lists but
         -- the row is kept (safety/audit). Re-uses the same hide-not-delete
         -- principle as blocks below.
         AND c.ended_at IS NULL
         -- Hide conversations where either side has blocked the other.
         -- We don't delete the conversation row (audit trail) — just
         -- filter it from this user's list.
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks ub
           WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
              OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
         )
         ${demoFilter}
       ORDER BY COALESCE(m.created_at, c.created_at) DESC`,
      [req.user.id]
    );

    res.json(rows.map(r => ({
      conversationId: r.conversation_id,
      otherUser: {
        id:         r.other_user_id,
        firstName:  r.first_name,
        // Initial only — the UI renders "First L.", so shipping the full surname
        // would just leak an unused field to the other user (privacy policy §3).
        lastInitial: (r.last_name || '').slice(0, 1).toUpperCase(),
        school:     r.school,
        photoUrl:   r.photo_url,
        isVerified: r.is_verified,
        lastActiveAt: r.last_active_at,
      },
      lastMessage:   r.last_message,
      lastMessageAt: r.last_message_at,
      isLastSenderMe: r.last_sender_id === req.user.id,
      unreadCount:   parseInt(r.unread_count),
      compatScore:   r.compat_score ? parseFloat(r.compat_score) : null,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// ── GET /messages/:conversationId ─────────────────────────────────────────
// Messages thread
// 60 thread fetches in 5 min is high — normal usage is opening a few chats
// and seeing live updates via socket.io. A scraper iterating through every
// conversationId looking for stored messages would trip this fast.
router.get('/:conversationId', requireAuth, suspicious.track('messages.thread', 60), async (req, res) => {
  try {
    // Verify user is part of this conversation AND not currently blocked
    // by the other party. The block check used to live only on the POST
    // (so a blocked user couldn't SEND), but the GET-thread path would
    // still return the historical message bodies — a user you blocked
    // could re-fetch your past messages by hitting this endpoint with
    // the conversation_id. Mirror the block filter here so blocked-by
    // means "can't read past messages either."
    const { rows: convRows } = await pool.query(
      `SELECT c.id, c.user_a, c.user_b
         FROM conversations c
        WHERE c.id = $1
          AND (c.user_a = $2 OR c.user_b = $2)
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks ub
             WHERE ub.blocker_id = CASE WHEN c.user_a = $2 THEN c.user_b ELSE c.user_a END
               AND ub.blocked_id = $2
          )`,
      [req.params.conversationId, req.user.id]
    );
    if (!convRows[0]) return res.status(403).json({ error: 'Not authorized' });

    const { rows } = await pool.query(
      `SELECT id, sender_id, body, read, created_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [req.params.conversationId]
    );

    // Mark messages as read. Stamp read_at too — this REST path (thread open)
    // usually wins the race against the socket 'mark_read', so without it
    // read_at never populated and read-receipts showed no timestamp. WHERE
    // read = FALSE means matched rows are unread, so NOW() never overwrites
    // an earlier read_at.
    pool.query(
      `UPDATE messages SET read = TRUE, read_at = NOW()
       WHERE conversation_id = $1 AND sender_id != $2 AND read = FALSE`,
      [req.params.conversationId, req.user.id]
    ).catch(() => {});

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ── POST /messages/:conversationId ────────────────────────────────────────
// Send a message (also used as fallback when socket is unavailable)
// Per-message char cap. 10K chars is roughly 2000 words — far beyond any
// reasonable chat message. Keeps a single bad actor from filling the
// messages table with multi-MB rows that bloat the conversation LATERAL
// join (which selects the full body for the messages tab preview).
const MAX_MESSAGE_CHARS = 10000;

router.post('/:conversationId', requireAuth, refuseBanned, async (req, res) => {
  try {
    const { body } = req.body || {};
    // Type-guard before calling .trim()/.length — a non-string body (a hostile
    // or buggy client sending {body: 123} or {body: {}}) would otherwise throw
    // and surface as a 500 instead of a clean 400.
    if (typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: 'body required' });
    if (body.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ error: `message exceeds ${MAX_MESSAGE_CHARS} char limit` });
    }

    // Accept-before-comms invariant: a `conversations` row only exists
    // once a connect_request has flipped to status='accepted' (see
    // routes/matches.js line ~284). So this membership check ALSO gates
    // pre-accept messaging — no conversation row → 403 here → no DM
    // possible until both sides agree to connect. Do NOT remove this
    // check, and do not add a code path that creates a conversation
    // outside the accept handler in matches.js.
    const { rows: convRows } = await pool.query(
      'SELECT user_a, user_b, ended_at FROM conversations WHERE id = $1 AND (user_a = $2 OR user_b = $2)',
      [req.params.conversationId, req.user.id]
    );
    if (!convRows[0]) return res.status(403).json({ error: 'Not authorized' });

    // Soft-disconnect ("unmatch"): the conversation is ended → no new messages
    // either way. Distinct from a block (which 403s above via user_blocks).
    if (convRows[0].ended_at) {
      return res.status(409).json({ error: 'This conversation has ended.', code: 'conversation_ended' });
    }

    // Block the send if either side has blocked the other. We refuse
    // BOTH directions — a blocked user can't message the blocker, and
    // the blocker (who chose to block) shouldn't accidentally reach out
    // either, since the conversation is filtered from their list anyway.
    const otherUserId = convRows[0].user_a === req.user.id
      ? convRows[0].user_b
      : convRows[0].user_a;
    const { rows: blockRows } = await pool.query(
      `SELECT 1 FROM user_blocks
        WHERE (blocker_id = $1 AND blocked_id = $2)
           OR (blocker_id = $2 AND blocked_id = $1)
        LIMIT 1`,
      [req.user.id, otherUserId],
    );
    if (blockRows[0]) {
      return res.status(403).json({ error: 'Unable to send message in this conversation.' });
    }

    // First-line content moderation (server-side, can't be bypassed by a
    // custom client). Egregious content is refused; scam signals are logged
    // for review but still delivered.
    const screen = screenMessage(body);
    if (screen.action === 'block') {
      logMessageFlag({
        conversationId: req.params.conversationId,
        senderId: req.user.id,
        recipientId: otherUserId,
        action: 'block',
        category: screen.category,
        excerpt: body,
      });
      return res.status(422).json({
        error: "This message can't be sent — it looks like it breaks our community guidelines. Keep messages respectful and safe.",
        code: 'content_blocked',
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, body)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.params.conversationId, req.user.id, body.trim()]
    );

    // Outcome scaffolding: stamp the 'message' funnel step (first occurrence
    // wins, so re-firing per message is harmless). Best-effort, non-blocking.
    recordPairingEvent(req.user.id, otherUserId, 'message').catch(() => {});

    if (screen.action === 'flag') {
      logMessageFlag({
        conversationId: req.params.conversationId,
        senderId: req.user.id,
        recipientId: otherUserId,
        action: 'flag',
        category: screen.category,
        excerpt: body,
        messageId: rows[0].id,
      });
    }

    // Real-time delivery. Emit ONLY to the recipient's personal socket room
    // (user:<id>), NOT the whole conversation room. The sender already
    // rendered this message optimistically with a client-side id; echoing it
    // back to them would arrive with the DB id and dedupe-by-id would miss it,
    // showing a duplicate. The recipient's client (stores/messageSocket.ts)
    // appends it to the open thread or bumps their unread count. The HTTP
    // INSERT above is the ONLY write — this is broadcast-only, so no double
    // message rows (the socket's own send_message handler is unused by the
    // web client). Best-effort: never let a socket hiccup fail the send.
    try {
      const io = req.app.get('io');
      if (io) {
        io.to(`user:${otherUserId}`).emit('new_message', {
          ...rows[0],
          senderName: req.user.first_name,
        });
      }
    } catch (emitErr) {
      console.error('[messages] socket emit failed:', emitErr.message);
    }

    // Recipient-side analytics — appears on the receiver's PostHog timeline
    // even though the frontend can only fire send-side events.
    analytics.track(analytics.EVENTS.message_received, otherUserId, {
      from_user_id: req.user.id,
      conversation_id: req.params.conversationId,
    });

    // Push notification to recipient (fire-and-forget). `otherUserId`
    // was computed above for the block check; reuse it here.
    const sendPushToUser = req.app.get('sendPushToUser');
    if (sendPushToUser) {
      sendPushToUser(otherUserId, {
        title: `${req.user.first_name} sent a message`,
        body: body.trim().slice(0, 80),
        data: { screen: 'thread', conversationId: req.params.conversationId },
      }).catch(err => console.error('[push] HTTP message send failed:', err));
    }

    // Email the recipient too (push never reaches web users). Throttled to the
    // first unread message in the conversation.
    maybeEmailNewMessage(req.params.conversationId, otherUserId, req.user.first_name).catch(() => {});

    // If the sender's own message signals self-harm/crisis, attach supportive
    // resources to the response (the message is still delivered). Clients show
    // a gentle 988 / Crisis Text Line card. This is care, not moderation —
    // nothing is blocked or logged to the abuse queue.
    res.status(201).json(screen.crisis ? { ...rows[0], support: CRISIS_SUPPORT } : rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── POST /messages/:conversationId/:messageId/report ───────────────────
// Long-press on a Journal message → "Report message" flows through here.
// Records the specific message id alongside the reported user so the
// moderator can pull up the exact flagged body instead of scrolling the
// whole thread. Membership-gated by the same conversation-membership
// rule the send endpoint uses, so a stranger can't hand-craft a
// conversationId + messageId to forge a report.
router.post('/:conversationId/:messageId/report', requireAuth, async (req, res) => {
  try {
    const { reason, details } = req.body || {};
    if (!reason || typeof reason !== 'string' || reason.length > 80) {
      return res.status(400).json({ error: 'reason (≤80 chars) required' });
    }
    if (details != null && (typeof details !== 'string' || details.length > 2000)) {
      return res.status(400).json({ error: 'details must be ≤2000 chars' });
    }

    // Verify the user is in the conversation and the message belongs to it.
    const { rows: msgRows } = await pool.query(
      `SELECT m.id, m.sender_id, c.user_a, c.user_b
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = $1
          AND c.id = $2
          AND (c.user_a = $3 OR c.user_b = $3)`,
      [req.params.messageId, req.params.conversationId, req.user.id],
    );
    const row = msgRows[0];
    if (!row) return res.status(403).json({ error: 'Not authorized' });
    if (row.sender_id === req.user.id) {
      return res.status(400).json({ error: "You can't report your own message" });
    }

    await pool.query(
      `INSERT INTO user_reports
         (reporter_id, reported_id, message_id, category, severity, reason, details)
       VALUES ($1, $2, $3, 'message', 'medium', $4, $5)`,
      [req.user.id, row.sender_id, row.id, reason.trim(), details?.trim() ?? null],
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('[messages/report] failed:', err.message);
    res.status(500).json({ error: 'Report failed' });
  }
});

module.exports = router;
