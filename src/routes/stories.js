const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { screenMessage, CRISIS_SUPPORT } = require('../lib/contentFilter');
const { isModeratorUser } = require('../utils/founders');
const { audit } = require('../services/auditLog');

// ═══════════════════════════════════════════════════════════════════════
// Stories — cross-user post feed (HavenIQ Stories, Roommate Stories
// screens). Posts are scoped to the author's school by default; the
// feed read returns the caller's school, so the network mechanic is
// "students at your campus share housing experiences".
//
// Content moderation: this is the one public, persistent, cross-user feed
// in the app that used to have NONE — no screenMessage call (unlike
// messages.js, sharedReviews.js, roommateVouches.js, reviews.js,
// agreements.js, matchOutcomes.js) and the `hidden` moderation column the
// schema already carried was never set by any code path. Now: egregious
// content is refused outright at POST time (same BLOCK_RULES messages.js
// uses); scam-signal content is still posted but flagged for review;
// crisis/self-harm language pages the safety team the same way a DM does.
// The admin routes below are the review surface that lets a moderator
// actually act on a flag or a founder-visible report — `hidden` finally
// does something.

function requireModerator(req, res, next) {
  if (!isModeratorUser(req.user)) {
    return res.status(403).json({ error: 'Moderator access required.' });
  }
  next();
}

// Self-healing columns (this repo's convention — see roommateSafety.js).
// Guards a fresh DB / a deploy that hasn't run the migration yet from
// 500ing the first flagged post or the first admin-review call.
let columnsReady = false;
async function ensureModerationColumns() {
  if (columnsReady) return;
  await pool.query(`
    ALTER TABLE stories ADD COLUMN IF NOT EXISTS flagged_category TEXT;
    ALTER TABLE stories ADD COLUMN IF NOT EXISTS flagged_at       TIMESTAMPTZ;
  `).catch((e) => console.error('[stories] ensure moderation columns:', e.message));
  columnsReady = true;
}

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

    // First-line content moderation — server-side, can't be bypassed by a
    // custom client. Same rules messages.js applies to DMs: egregious
    // content (slurs, threats, explicit solicitation) is refused outright;
    // scam signals are posted but flagged for review, not blocked.
    await ensureModerationColumns();
    const screen = screenMessage(`${title}\n${body}`);
    if (screen.action === 'block') {
      // A self-harm/crisis signal can co-occur with blocked content — a
      // rejected post must not also drop the person most likely to need
      // support. Escalate regardless of the block, same as messages.js.
      if (screen.crisis) {
        require('../services/crisisAlert')
          .maybeAlertCrisis(req.user, `story:blocked:${req.user.id}`)
          .catch(() => {});
      }
      return res.status(422).json({
        error: "This story can't be posted — it looks like it breaks our community guidelines. Keep posts respectful and safe.",
        code: 'content_blocked',
        ...(screen.crisis ? { support: CRISIS_SUPPORT } : {}),
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO stories (author_id, is_anonymous, school, title, body, category, flagged_category, flagged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, created_at`,
      [
        req.user.id,
        !!isAnonymous,
        req.user.school,
        title.trim(),
        body.trim(),
        category ? String(category).slice(0, 32) : null,
        screen.action === 'flag' ? screen.category : null,
        screen.action === 'flag' ? new Date() : null,
      ],
    );

    if (screen.crisis) {
      require('../services/crisisAlert')
        .maybeAlertCrisis(req.user, `story:${rows[0].id}`)
        .catch(() => {});
    }

    res.json({
      id: rows[0].id,
      createdAt: rows[0].created_at,
      ...(screen.crisis ? { support: CRISIS_SUPPORT } : {}),
    });
  } catch (err) {
    console.error('story post failed:', err);
    res.status(500).json({ error: 'Failed to post story' });
  }
});

// ── GET /stories/admin ──────────────────────────────────────────────────
// Moderator review surface. Previously the `hidden` column existed and was
// correctly filtered out of the public feed (GET /), but nothing anywhere
// ever SET it — there was no way for staff to ever act on bad content once
// posted. ?filter=flagged (default) shows only scam-flagged posts;
// ?filter=all shows every post at every school, hidden or not.
router.get('/admin', requireAuth, requireModerator, async (req, res) => {
  try {
    await ensureModerationColumns();
    const flaggedOnly = req.query.filter !== 'all';
    const { rows } = await pool.query(
      `SELECT s.id, s.title, s.body, s.category, s.school, s.is_anonymous, s.hidden,
              s.flagged_category, s.flagged_at, s.created_at,
              s.author_id, u.first_name, u.email
       FROM stories s
       LEFT JOIN users u ON u.id = s.author_id
       ${flaggedOnly ? 'WHERE s.flagged_category IS NOT NULL' : ''}
       ORDER BY s.created_at DESC
       LIMIT 200`,
    );
    res.json({ stories: rows });
  } catch (err) {
    console.error('[stories] admin list failed:', err);
    res.status(500).json({ error: 'Failed to load stories' });
  }
});

// ── PATCH /stories/:id ──────────────────────────────────────────────────
// Moderator hide/unhide. Body: { hidden: boolean }. This is the action the
// `hidden` column was always meant to support.
router.patch('/:id', requireAuth, requireModerator, async (req, res) => {
  try {
    const hidden = req.body?.hidden;
    if (typeof hidden !== 'boolean') {
      return res.status(400).json({ error: 'hidden (boolean) is required' });
    }
    const { rowCount } = await pool.query(
      'UPDATE stories SET hidden = $1 WHERE id = $2',
      [hidden, req.params.id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'story not found' });
    audit(req, hidden ? 'story.hide' : 'story.unhide', { storyId: req.params.id }).catch(() => {});
    res.json({ ok: true, hidden });
  } catch (err) {
    console.error('[stories] patch failed:', err);
    res.status(500).json({ error: 'Failed to update story' });
  }
});

module.exports = router;
