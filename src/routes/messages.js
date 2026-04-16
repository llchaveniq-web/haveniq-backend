const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

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
       WHERE c.user_a = $1 OR c.user_b = $1
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
router.get('/:conversationId', requireAuth, async (req, res) => {
  try {
    // Verify user is part of this conversation
    const { rows: convRows } = await pool.query(
      'SELECT * FROM conversations WHERE id = $1 AND (user_a = $2 OR user_b = $2)',
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
router.post('/:conversationId', requireAuth, async (req, res) => {
  try {
    const { body } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'body required' });

    // Verify user is part of conversation
    const { rows: convRows } = await pool.query(
      'SELECT * FROM conversations WHERE id = $1 AND (user_a = $2 OR user_b = $2)',
      [req.params.conversationId, req.user.id]
    );
    if (!convRows[0]) return res.status(403).json({ error: 'Not authorized' });

    const { rows } = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, body)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.params.conversationId, req.user.id, body.trim()]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
