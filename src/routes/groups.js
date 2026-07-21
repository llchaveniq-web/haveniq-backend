const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { calculateGroupCompatibility, flatten } = require('../services/scoring');
const { isFounder } = require('../utils/founders');
const { isDemo } = require('../lib/demoFilter');

// Normalize the wire shape of quiz answers into the flat
// { questionId: number } map the scoring engine expects.
// Delegates to the scorer's flatten — the ONE correct reader of the stored
// answers map. This used to be a near-copy that handled the object form but
// dropped numeric strings ("2"), which the scorer accepts; a third divergent
// copy is how the About You and Matched Moment readers silently broke.
function normalizeAnswers(raw) {
  return flatten(raw || {});
}

// Two integer ranges overlap if neither is entirely left or right of the
// other. Treats nulls as "no constraint" → always overlapping.
function rangesOverlap(aMin, aMax, bMin, bMax) {
  if (aMax != null && bMin != null && aMax < bMin) return false;
  if (bMax != null && aMin != null && bMax < aMin) return false;
  return true;
}

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

// ── GET /groups/feed?groupId=... ──────────────────────────────────────────
// Squad-to-squad discovery. For the caller's group (must be `forming`),
// returns up to 10 other `forming` squads ranked by cross-group
// compatibility, filtered to same school and overlapping budget /
// move-in window. The score is the average pairwise score across every
// cross-group member pair (see calculateGroupCompatibility).
//
// Caller must be a member of the requested group — prevents random users
// from probing other squads' compositions.
router.get('/feed', requireAuth, async (req, res) => {
  const groupId = req.query.groupId;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });

  try {
    // Verify membership.
    const { rows: memberCheck } = await pool.query(
      'SELECT 1 FROM match_group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, req.user.id],
    );
    if (!memberCheck[0]) return res.status(403).json({ error: 'Not a member of this group' });

    const { rows: callerRows } = await pool.query(
      `SELECT g.id, g.status, g.budget_per_person_min, g.budget_per_person_max, g.move_in_window,
              MIN(u.school) AS school
       FROM match_groups g
       JOIN match_group_members m ON m.group_id = g.id
       JOIN users u ON u.id = m.user_id
       WHERE g.id = $1
       GROUP BY g.id`,
      [groupId],
    );
    const caller = callerRows[0];
    if (!caller) return res.status(404).json({ error: 'Group not found' });

    // Caller's members + their answers.
    const { rows: callerMembers } = await pool.query(
      `SELECT u.id, qa.answers
       FROM match_group_members m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN quiz_answers qa ON qa.user_id = u.id AND qa.completed = TRUE
       WHERE m.group_id = $1`,
      [groupId],
    );
    const callerAnswers = callerMembers
      .filter(r => r.answers)
      .map(r => normalizeAnswers(r.answers));

    if (callerAnswers.length === 0) {
      return res.json({ matches: [], reason: 'Group has no completed-quiz members yet' });
    }

    // Candidates: forming groups at same school (any member), excluding self.
    // Demo groups surface only when DEMO_FEED=true (investor pitches); by
    // default the founder sees real forming groups like everyone else.
    const includeDemos = isFounder(req.user.id) && process.env.DEMO_FEED === 'true';
    const demoFilter   = includeDemos ? '' : `AND NOT EXISTS (
      SELECT 1 FROM match_group_members mm2
      JOIN users u2 ON u2.id = mm2.user_id
      WHERE mm2.group_id = g.id AND ${isDemo('u2.email')}
    )`;

    const { rows: candidates } = await pool.query(
      `SELECT g.id, g.name, g.size_target, g.move_in_window,
              g.budget_per_person_min, g.budget_per_person_max,
              g.created_at,
              (SELECT COUNT(*)::int FROM match_group_members WHERE group_id = g.id) AS member_count
       FROM match_groups g
       WHERE g.status = 'forming'
         AND g.id != $1
         AND EXISTS (
           SELECT 1 FROM match_group_members mm
           JOIN users u ON u.id = mm.user_id
           WHERE mm.group_id = g.id AND u.school = $2
         )
         ${demoFilter}
       LIMIT 50`,
      [groupId, caller.school],
    );

    const results = [];
    for (const cand of candidates) {
      if (!rangesOverlap(
        caller.budget_per_person_min, caller.budget_per_person_max,
        cand.budget_per_person_min,  cand.budget_per_person_max,
      )) continue;

      const { rows: candMembers } = await pool.query(
        `SELECT u.id, u.first_name, u.last_name, u.photo_url, qa.answers
         FROM match_group_members m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN quiz_answers qa ON qa.user_id = u.id AND qa.completed = TRUE
         WHERE m.group_id = $1`,
        [cand.id],
      );

      const candAnswers = candMembers
        .filter(r => r.answers)
        .map(r => normalizeAnswers(r.answers));
      if (candAnswers.length === 0) continue;

      const score = calculateGroupCompatibility(callerAnswers, candAnswers);
      if (!score || score.isHardBlocked) continue;

      results.push({
        id:             cand.id,
        name:           cand.name,
        sizeTarget:     cand.size_target,
        memberCount:    cand.member_count,
        moveInWindow:   cand.move_in_window,
        budgetMin:      cand.budget_per_person_min,
        budgetMax:      cand.budget_per_person_max,
        score:          score.finalPct,
        members: candMembers.map(m => ({
          id:          m.id,
          firstName:   m.first_name,
          lastInitial: (m.last_name || '').slice(0, 1).toUpperCase(),
          photoUrl:    m.photo_url,
        })),
      });
    }

    results.sort((a, b) => b.score - a.score);
    res.json({ matches: results.slice(0, 10) });
  } catch (err) {
    console.error('group feed failed:', err);
    res.status(500).json({ error: 'Failed to load squad matches' });
  }
});

// ── POST /groups/:id/express-interest ────────────────────────────────────
// Caller's group (passed via body.fromGroupId) signals interest in :id.
// Idempotent — duplicate signal returns the existing row. Auto-flips to
// 'accepted' if the reverse signal already exists (mutual interest).
router.post('/:id/express-interest', requireAuth, async (req, res) => {
  const toGroup = req.params.id;
  const fromGroup = req.body?.fromGroupId;
  if (!fromGroup) return res.status(400).json({ error: 'fromGroupId required' });
  if (fromGroup === toGroup) return res.status(400).json({ error: 'Cannot express interest in your own squad' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: memberCheck } = await client.query(
      'SELECT 1 FROM match_group_members WHERE group_id = $1 AND user_id = $2',
      [fromGroup, req.user.id],
    );
    if (!memberCheck[0]) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not a member of the requesting squad' });
    }

    // Check for reverse interest — mutual signals auto-accept.
    const { rows: reverse } = await client.query(
      `SELECT id FROM group_interests
       WHERE from_group = $1 AND to_group = $2 AND status = 'pending'`,
      [toGroup, fromGroup],
    );
    const mutual = reverse.length > 0;

    const { rows: inserted } = await client.query(
      `INSERT INTO group_interests (from_group, to_group, initiator_id, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (from_group, to_group) DO UPDATE
         SET status = EXCLUDED.status
       RETURNING id, status, created_at`,
      [fromGroup, toGroup, req.user.id, mutual ? 'accepted' : 'pending'],
    );

    if (mutual) {
      await client.query(
        `UPDATE group_interests SET status = 'accepted' WHERE id = $1`,
        [reverse[0].id],
      );
    }

    await client.query('COMMIT');
    res.json({ interest: inserted[0], mutual });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('express-interest failed:', err);
    res.status(500).json({ error: 'Failed to send interest' });
  } finally {
    client.release();
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
      `SELECT g.id, g.size_target, g.status, u.school AS creator_school,
              (SELECT COUNT(*)::int FROM match_group_members WHERE group_id = $1) AS member_count
       FROM match_groups g JOIN users u ON u.id = g.creator_id WHERE g.id = $1`,
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

    // Campus scope: squads are same-campus (roommates share one place). Only a
    // student at the squad's campus may join — this closes the "any authed user
    // self-joins any squad by id" gap without needing an invite model. Case-
    // insensitive; a missing school on either side passes (don't hard-block a
    // profile that hasn't set a school yet).
    if (group.creator_school && req.user.school &&
        group.creator_school.trim().toLowerCase() !== req.user.school.trim().toLowerCase()) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This squad is for a different campus.' });
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
