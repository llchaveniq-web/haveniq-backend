const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

// ── POST /groups ──────────────────────────────────────────────────────────
// Create a new squad. The creator is automatically added as the first
// member with role='creator'. Returns the created group + member list.
//
// Body: {
//   name:            string (required),
//   sizeTarget:      2 | 3 | 4 | 5 (required),
//   budgetPerPersonMin?: number,
//   budgetPerPersonMax?: number,
//   moveInWindow?:   string,
// }
router.post('/', requireAuth, async (req, res) => {
  const { name, sizeTarget, budgetPerPersonMin, budgetPerPersonMax, moveInWindow } = req.body || {};

  if (typeof name !== 'string' || name.trim().length < 2) {
    return res.status(400).json({ error: 'name required (min 2 chars)' });
  }
  if (![2, 3, 4, 5].includes(sizeTarget)) {
    return res.status(400).json({ error: 'sizeTarget must be 2, 3, 4, or 5' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: groupRows } = await client.query(
      `INSERT INTO match_groups
         (name, creator_id, size_target, budget_per_person_min,
          budget_per_person_max, move_in_window)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, creator_id, size_target, budget_per_person_min,
                 budget_per_person_max, move_in_window, status, created_at`,
      [
        name.trim(),
        req.user.id,
        sizeTarget,
        budgetPerPersonMin ?? null,
        budgetPerPersonMax ?? null,
        moveInWindow ?? null,
      ],
    );

    const group = groupRows[0];

    await client.query(
      `INSERT INTO match_group_members (group_id, user_id, role)
       VALUES ($1, $2, 'creator')`,
      [group.id, req.user.id],
    );

    await client.query('COMMIT');
    res.json({ group, memberCount: 1 });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('group create failed:', err);
    res.status(500).json({ error: 'Failed to create group' });
  } finally {
    client.release();
  }
});

// ── GET /groups/me ────────────────────────────────────────────────────────
// All groups the current user is a member of. Includes other members'
// names + emails so the UI can render member chips.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         g.id, g.name, g.size_target, g.status, g.move_in_window,
         g.budget_per_person_min, g.budget_per_person_max,
         g.created_at,
         (SELECT COUNT(*) FROM match_group_members WHERE group_id = g.id) AS member_count,
         g.creator_id = $1 AS is_creator
       FROM match_groups g
       JOIN match_group_members m ON m.group_id = g.id
       WHERE m.user_id = $1 AND g.status != 'archived'
       ORDER BY g.created_at DESC`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) {
    console.error('group list failed:', err);
    res.status(500).json({ error: 'Failed to load groups' });
  }
});

// ── POST /groups/:id/join ─────────────────────────────────────────────────
// Accept a squad invite. Idempotent — joining when already a member is a
// no-op success. Blocks: group not found (404), group already at
// size_target (409), group archived (410).
router.post('/:id/join', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: groupRows } = await client.query(
      `SELECT id, size_target, status,
              (SELECT COUNT(*)::int FROM match_group_members WHERE group_id = $1) AS member_count
       FROM match_groups WHERE id = $1`,
      [req.params.id],
    );
    const group = groupRows[0];
    if (!group) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Squad not found' });
    }
    if (group.status === 'archived') {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'This squad has been archived' });
    }

    const { rows: existing } = await client.query(
      'SELECT 1 FROM match_group_members WHERE group_id = $1 AND user_id = $2',
      [group.id, req.user.id],
    );
    if (existing[0]) {
      await client.query('COMMIT');
      return res.json({ joined: true, alreadyMember: true });
    }

    if (group.member_count >= group.size_target) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This squad is already full' });
    }

    await client.query(
      `INSERT INTO match_group_members (group_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [group.id, req.user.id],
    );

    // Auto-flip to 'complete' when the group hits its size target.
    if (group.member_count + 1 >= group.size_target) {
      await client.query(
        `UPDATE match_groups SET status = 'complete', updated_at = NOW() WHERE id = $1`,
        [group.id],
      );
    }

    await client.query('COMMIT');
    res.json({ joined: true, alreadyMember: false });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('group join failed:', err);
    res.status(500).json({ error: 'Failed to join squad' });
  } finally {
    client.release();
  }
});

// ── GET /groups/:id ───────────────────────────────────────────────────────
// Single group detail with members. 403 if the caller isn't a member.
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows: memberRows } = await pool.query(
      `SELECT m.role, u.id, u.first_name, u.last_name, u.school, u.photo_url
       FROM match_group_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.group_id = $1`,
      [req.params.id],
    );

    const isMember = memberRows.some(r => r.id === req.user.id);
    if (!isMember) return res.status(403).json({ error: 'Not a member of this group' });

    const { rows: groupRows } = await pool.query(
      `SELECT id, name, creator_id, size_target, budget_per_person_min,
              budget_per_person_max, move_in_window, status, created_at
       FROM match_groups WHERE id = $1`,
      [req.params.id],
    );
    if (!groupRows[0]) return res.status(404).json({ error: 'Group not found' });

    res.json({ group: groupRows[0], members: memberRows });
  } catch (err) {
    console.error('group fetch failed:', err);
    res.status(500).json({ error: 'Failed to load group' });
  }
});

module.exports = router;
