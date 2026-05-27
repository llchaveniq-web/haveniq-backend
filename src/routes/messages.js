const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, refuseBanned } = require('../middleware/auth');
const suspicious = require('../middleware/suspiciousActivity');
const analytics = require('../services/analytics');

// ── GET /messages/conversations ───────────────────────────────────────────
// All conversations for the current user with last message
router.get('/conversations', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         c.id AS conversation_id,
         CASE WHEN c.user_a = $1 THEN c.user_b ELSE c.user_a END AS other_user_id,
         u.first_name, u.last_name, u.school, u.photo_url, u.is_verified,
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
         -- Hide conversations where either side has blocked the other.
         -- We don't delete the conversation row (audit trail) — just
         -- filter it from this user's list.
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks ub
           WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
              OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
         )
       ORDER BY COALESCE(m.created_at, c.created_at) DESC`,
      [req.user.id]
    );

    res.json(rows.map(r => ({
      conversationId: r.conversation_id,
      otherUser: {
        id:         r.other_user_id,
        firstName:  r.first_name,
        lastName:   r.last_name,
        school:     r.school,
        photoUrl:   r.photo_url,
        isVerified: r.is_verified,
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
    // Verify user is part of this conversation
    const { rows: convRows } = await pool.query(
      'SELECT id, user_a, user_b FROM conversations WHERE id = $1 AND (user_a = $2 OR user_b = $2)',
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

    // Mark messages as read
    pool.query(
      `UPDATE messages SET read = TRUE
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
    if (!body?.trim()) return res.status(400).json({ error: 'body required' });
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
      'SELECT user_a, user_b FROM conversations WHERE id = $1 AND (user_a = $2 OR user_b = $2)',
      [req.params.conversationId, req.user.id]
    );
    if (!convRows[0]) return res.status(403).json({ error: 'Not authorized' });

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

    const { rows } = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, body)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.params.conversationId, req.user.id, body.trim()]
    );

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

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
