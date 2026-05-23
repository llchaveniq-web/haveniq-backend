const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

// ═══════════════════════════════════════════════════════════════════════
// Stories — cross-user post feed (HavenIQ Stories, Roommate Stories
// screens). Posts are scoped to the author's school by default; the
// feed read returns the caller's school, so the network mechanic is
// "students at your campus share housing experiences".
// ═══════════════════════════════════════════════════════════════════════

// ── GET /stories ─────────────────────────────────────────────────────────
// Returns recent stories at the caller's school. Anonymous posts have
// their author info nulled out before serialization.
// Query: ?limit=20 (default 50, max 100), ?category=success|warning|tip
router.get('/', requireAuth, async (req, res) => {
  try {
    const limit    = Math.min(Number(req.query.limit) || 50, 100);
    const category = req.query.category ? String(req.query.category) : null;

    const params = [req.user.school, limit];
    let where = 'WHERE s.school = $1 AND s.hidden = FALSE';
    if (category) {
      params.splice(1, 0, category);
      where += ' AND s.category = $2';
    }

    const { rows } = await pool.query(
      `SELECT s.id, s.title, s.body, s.category, s.is_anonymous, s.created_at,
              u.first_name, u.last_name, u.photo_url
       FROM stories s
       LEFT JOIN users u ON u.id = s.author_id
       ${where}
       ORDER BY s.created_at DESC
       LIMIT $${params.length}`,
      params,
    );

    res.json(rows.map(r => ({
      id:          r.id,
      title:       r.title,
      body:        r.body,
      category:    r.category,
      createdAt:   r.created_at,
      isAnonymous: r.is_anonymous,
      // Strip author info when anonymous
      author: r.is_anonymous
        ? { firstName: 'Anonymous', lastInitial: '', photoUrl: null }
        : {
            firstName:   r.first_name ?? 'Student',
            lastInitial: (r.last_name || '').charAt(0),
            photoUrl:    r.photo_url,
          },
    })));
  } catch (err) {
    console.error('stories list failed:', err);
    res.status(500).json({ error: 'Failed to load stories' });
  }
});

// ── POST /stories ────────────────────────────────────────────────────────
// Body: { title, body, category?, isAnonymous? }
router.post('/', requireAuth, async (req, res) => {
  try {
    const { title, body, category, isAnonymous } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'title required' });
    if (!body  || !body.trim())  return res.status(400).json({ error: 'body required' });
    if (title.length > 200)      return res.status(400).json({ error: 'title too long' });
    if (body.length  > 4000)     return res.status(400).json({ error: 'body too long' });

    const { rows } = await pool.query(
      `INSERT INTO stories (author_id, is_anonymous, school, title, body, category)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [
        req.user.id,
        !!isAnonymous,
        req.user.school,
        title.trim(),
        body.trim(),
        category ? String(category).slice(0, 32) : null,
      ],
    );
    res.json({ id: rows[0].id, createdAt: rows[0].created_at });
  } catch (err) {
    console.error('story post failed:', err);
    res.status(500).json({ error: 'Failed to post story' });
  }
});

module.exports = router;
