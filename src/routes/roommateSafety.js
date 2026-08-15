const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
// The patch as written imported `requireAdmin` — which does NOT exist in this
// repo (importing it made the admin route handler `undefined`, and Express
// throws at module load → the server never boots). The real admin gate is
// requireFounder (founder ⊆ the only privileged role today).
const { requireFounder } = require('../middleware/requireFounder');

// Must match the frontend's ROOMMATE_SAFETY_REASONS exactly.
const VALID_CATEGORIES = [
  'Threats or intimidation',
  'Physical aggression',
  "Won't respect my space or boundaries",
  'Substance-related behavior that scares me',
  'Escalating pattern of conflict',
  'Other safety concern',
];

// Self-healing table create (this repo's convention — migrate_missing.sql runs
// it on boot; this guard means a fresh DB or a skipped migration never 500s the
// first write). gen_random_uuid needs pgcrypto, which migrate_missing ensures.
let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  // reporter_id / reported_id are nullable with ON DELETE SET NULL — NOT the
  // ON DELETE CASCADE this table originally shipped with. A safety report is
  // evidence about a pattern of behavior, not the reporter's or reported
  // person's data to erase by deleting their account (GDPR Art. 17 itself
  // carves out an exception for records needed for "establishment, exercise
  // or defence of legal claims", which a filed safety report is). This
  // mirrors the already-correct precedent set by user_reports and
  // audit_log.user_id elsewhere in this schema — this table was the outlier.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS roommate_safety_reports (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      reporter_id UUID REFERENCES users(id) ON DELETE SET NULL,
      reported_id UUID REFERENCES users(id) ON DELETE SET NULL,
      category    TEXT NOT NULL,
      detail      TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_safety_reports_reported ON roommate_safety_reports(reported_id);
    CREATE INDEX IF NOT EXISTS idx_safety_reports_reporter ON roommate_safety_reports(reporter_id);
  `).catch((e) => console.error('[roommate-safety-reports] ensure table:', e.message));
  // Founder review state — this table had a real-time Discord alert on a
  // forming pattern but no durable, browsable review surface at all: the
  // ONLY way to ever see the accumulated data was catching the alert live
  // in Discord. 'open' by default so nothing already-filed is silently
  // marked reviewed by the migration itself.
  await pool.query(`
    ALTER TABLE roommate_safety_reports ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'
  `).catch((e) => console.error('[roommate-safety-reports] add status column:', e.message));

  // Denormalized snapshot of who a report was filed by/against, taken at
  // filing time. Once reporter_id/reported_id go SET NULL on account
  // deletion, a bare live JOIN against users has nothing left to show a
  // founder reviewing an old report — these columns are what keeps a report
  // legible ("this was about Jane Doe, jane@school.edu") after the person
  // behind it is gone.
  await pool.query(`
    ALTER TABLE roommate_safety_reports ADD COLUMN IF NOT EXISTS reporter_name  TEXT;
    ALTER TABLE roommate_safety_reports ADD COLUMN IF NOT EXISTS reporter_email TEXT;
    ALTER TABLE roommate_safety_reports ADD COLUMN IF NOT EXISTS reported_name  TEXT;
    ALTER TABLE roommate_safety_reports ADD COLUMN IF NOT EXISTS reported_email TEXT;
  `).catch((e) => console.error('[roommate-safety-reports] add snapshot columns:', e.message));

  // One-time backfill for rows filed before this column existed, while the
  // referenced users are still around to read from. Rows whose users are
  // already gone by now predate this fix and stay un-backfilled — nothing
  // to source the snapshot from — but every report about a still-live user
  // gets one going forward.
  await pool.query(`
    UPDATE roommate_safety_reports r SET reporter_name = u.first_name, reporter_email = u.email
      FROM users u WHERE u.id = r.reporter_id AND r.reporter_name IS NULL;
    UPDATE roommate_safety_reports r SET reported_name = u.first_name, reported_email = u.email
      FROM users u WHERE u.id = r.reported_id AND r.reported_name IS NULL;
  `).catch((e) => console.error('[roommate-safety-reports] backfill snapshot columns:', e.message));

  // Existing deployments created this table before the CASCADE -> SET NULL
  // change above — CREATE TABLE IF NOT EXISTS is a no-op there, so the old
  // constraints (and NOT NULL) need an explicit migration. Guarded on the
  // constraint's current delete-rule so this is a no-op once applied.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'roommate_safety_reports_reporter_id_fkey' AND confdeltype != 'n'
      ) THEN
        ALTER TABLE roommate_safety_reports ALTER COLUMN reporter_id DROP NOT NULL;
        ALTER TABLE roommate_safety_reports DROP CONSTRAINT roommate_safety_reports_reporter_id_fkey;
        ALTER TABLE roommate_safety_reports ADD CONSTRAINT roommate_safety_reports_reporter_id_fkey
          FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE SET NULL;
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'roommate_safety_reports_reported_id_fkey' AND confdeltype != 'n'
      ) THEN
        ALTER TABLE roommate_safety_reports ALTER COLUMN reported_id DROP NOT NULL;
        ALTER TABLE roommate_safety_reports DROP CONSTRAINT roommate_safety_reports_reported_id_fkey;
        ALTER TABLE roommate_safety_reports ADD CONSTRAINT roommate_safety_reports_reported_id_fkey
          FOREIGN KEY (reported_id) REFERENCES users(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `).catch((e) => console.error('[roommate-safety-reports] migrate FK delete-rule:', e.message));

  tableReady = true;
}

// Post a safety alert to Discord. There is no shared Discord helper in this repo
// — /telemetry/report posts inline to DISCORD_WEBHOOK_URL — so this reuses that
// SAME channel by default (the founder already watches it), mirroring its embed
// shape. DISCORD_SAFETY_WEBHOOK_URL, if set, overrides to a dedicated safety
// channel. No webhook configured (dev/test) → silent no-op.
async function postSafetyAlert({ title, description, fields }) {
  const hook = process.env.DISCORD_SAFETY_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!hook) return;
  try {
    const r = await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title,
          description,
          color: 0xDC2626, // red — this is a safety pattern, not a routine report
          fields: fields || [],
          footer: { text: 'Roommate safety • forming pattern' },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
    if (!r.ok) console.error('[roommate-safety-reports] Discord webhook returned', r.status);
  } catch (err) {
    console.error('[roommate-safety-reports] Discord post failed:', err.message);
  }
}

// Real-time pattern detector, fired the instant a NEW distinct reporter files
// against an ALREADY-reported person — so a forming pattern surfaces immediately
// instead of waiting for someone to load the /admin dashboard. Fire-and-forget
// and fully self-contained (never throws), so it can't affect the POST response
// that already went out.
//
// Fires iff, AFTER this insert: the reported person has >= 2 DISTINCT reporters
// AND this reporter has exactly ONE report of them (i.e. this is that reporter's
// first). That is exactly "first from a new distinct reporter against an
// already-reported person":
//   - never on a person's first-ever report (distinct_reporters would be 1);
//   - never twice for the same reporter+person (my_reports would be >= 2).
async function maybeAlertPattern(reporterId, reportedId) {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT reporter_id)::int                      AS distinct_reporters,
              COUNT(*) FILTER (WHERE reporter_id = $2)::int         AS my_reports
         FROM roommate_safety_reports
        WHERE reported_id = $1`,
      [reportedId, reporterId],
    );
    const distinctReporters = rows[0]?.distinct_reporters || 0;
    const myReports = rows[0]?.my_reports || 0;
    if (!(distinctReporters >= 2 && myReports === 1)) return;

    // Best-effort name for the alert; the reviewer opens /admin for the detail.
    const { rows: u } = await pool.query('SELECT first_name FROM users WHERE id = $1', [reportedId]);
    const name = u[0]?.first_name || 'a student';

    await postSafetyAlert({
      title: '🚨 Roommate safety pattern forming',
      description:
        `**${name}** has now been reported by **${distinctReporters}** different students ` +
        `(a new distinct reporter just filed). Review in the safety dashboard: ` +
        `GET /roommate-safety-reports/admin`,
      fields: [
        { name: 'Reported user', value: String(reportedId), inline: false },
        { name: 'Distinct reporters', value: String(distinctReporters), inline: true },
      ],
    });
  } catch (err) {
    console.error('[roommate-safety-reports] pattern alert failed:', err.message);
  }
}

// POST /roommate-safety-reports — file a new report.
router.post('/', requireAuth, async (req, res) => {
  try {
    await ensureTable();
    const reporterId = String(req.user.id);
    const { reportedId, category, detail } = req.body || {};
    if (!reportedId || typeof reportedId !== 'string') {
      return res.status(400).json({ ok: false, error: 'reportedId is required' });
    }
    if (!VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ ok: false, error: 'Invalid category' });
    }
    if (reportedId === reporterId) {
      return res.status(400).json({ ok: false, error: "Can't report yourself" });
    }

    // Snapshot both names/emails at filing time — see ensureTable's comment.
    // req.user already has the reporter's; the reported person needs a
    // lookup. A missing row here just means the INSERT below fails on the
    // FK constraint, same as before this change.
    const { rows: reportedUser } = await pool.query(
      'SELECT first_name, email FROM users WHERE id = $1',
      [reportedId],
    );

    const { rows } = await pool.query(
      `INSERT INTO roommate_safety_reports
         (reporter_id, reported_id, category, detail, reporter_name, reporter_email, reported_name, reported_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        reporterId, reportedId, category, (detail || '').slice(0, 2000),
        req.user.first_name || null, req.user.email || null,
        reportedUser[0]?.first_name || null, reportedUser[0]?.email || null,
      ],
    );

    res.json({ ok: true, id: rows[0].id });

    // Real-time pattern alert — fire-and-forget AFTER the response, so it can
    // never delay or fail the student's report.
    maybeAlertPattern(reporterId, reportedId);
  } catch (err) {
    console.error('[roommate-safety-reports] POST failed', err);
    res.status(500).json({ ok: false, error: 'Could not save report' });
  }
});

// GET /roommate-safety-reports/mine — a reporter's own filing history.
router.get('/mine', requireAuth, async (req, res) => {
  try {
    await ensureTable();
    const uid = String(req.user.id);
    const { rows } = await pool.query(
      `SELECT id, reported_id, category, detail, created_at
       FROM roommate_safety_reports
       WHERE reporter_id = $1
       ORDER BY created_at DESC`,
      [uid],
    );
    res.json({ ok: true, reports: rows });
  } catch (err) {
    console.error('[roommate-safety-reports] GET /mine failed', err);
    res.status(500).json({ ok: false, error: 'Could not load reports' });
  }
});

const VALID_STATUSES = new Set(['open', 'reviewed']);

// GET /roommate-safety-reports/admin — the safety-team view. Surfaces PATTERNS
// (same reported_id, DISTINCT reporter_ids): one student reported by several
// different people is the signal worth immediate attention. Previously this
// was the ONLY way to ever see this data, and nothing ever called it — the
// real-time Discord alert (maybeAlertPattern) was the sole review surface,
// which meant a pattern was reviewable exactly once: the moment it scrolled
// past in Discord. This is the durable version.
//
// ?status=open|reviewed|all (default 'open', matching AdminSafetyAPI's own
// convention) filters the REPORTS list only — patterns are always computed
// from the FULL history regardless of the filter, since "this person has
// been reported by 3 different students" doesn't stop being true just
// because a founder marked one of those reports reviewed.
//
// NOTE the path change from the patch. The patch mounted this router at
// '/roommate-safety-reports' but declared the route as
// '/admin/roommate-safety-reports', so its real URL would have been
// '/roommate-safety-reports/admin/roommate-safety-reports' — not the documented
// contract. Declared as '/admin' here so the effective URL is
// '/roommate-safety-reports/admin'. (There is no separate top-level /admin mount
// this could have reached.)
router.get('/admin', requireAuth, requireFounder, async (req, res) => {
  try {
    await ensureTable();
    // LEFT JOIN, not JOIN — reporter_id/reported_id go NULL when that
    // account is deleted (ON DELETE SET NULL), and the report must still
    // show up. COALESCE onto the filing-time snapshot (reporter_name/
    // reported_name/reported_email) so a report about a since-deleted
    // account stays legible instead of just vanishing from this list.
    const { rows: allReports } = await pool.query(
      `SELECT
         r.id, r.category, r.detail, r.created_at, r.status,
         r.reporter_id, COALESCE(reporter.first_name, r.reporter_name) AS reporter_first_name,
         COALESCE(reporter.email, r.reporter_email) AS reporter_email,
         r.reported_id, COALESCE(reported.first_name, r.reported_name) AS reported_first_name,
         COALESCE(reported.email, r.reported_email) AS reported_email
       FROM roommate_safety_reports r
       LEFT JOIN users reporter ON reporter.id = r.reporter_id
       LEFT JOIN users reported ON reported.id = r.reported_id
       ORDER BY r.created_at DESC`,
    );

    // Group into patterns keyed by whoever was reported. reported_id alone
    // isn't safe once deletions can null it out — every deleted person's
    // reports would collapse into one `null` bucket together. Falling back
    // to the snapshotted email keeps DIFFERENT deleted people's reports
    // from merging into a single false "pattern".
    const byReported = new Map();
    for (const r of allReports) {
      const key = r.reported_id || (r.reported_email ? `email:${r.reported_email}` : `report:${r.id}`);
      const bucket = byReported.get(key)
        ?? { reportedId: r.reported_id, name: r.reported_first_name, reporterIds: new Set() };
      bucket.reporterIds.add(r.reporter_id || (r.reporter_email ? `email:${r.reporter_email}` : `report:${r.id}`));
      byReported.set(key, bucket);
    }
    const patterns = [...byReported.values()]
      .filter(b => b.reporterIds.size > 1)
      .map(b => ({ reportedId: b.reportedId, name: b.name, distinctReporterCount: b.reporterIds.size }))
      .sort((a, b) => b.distinctReporterCount - a.distinctReporterCount);

    const statusFilter = String(req.query.status || 'open');
    const reports = statusFilter === 'all'
      ? allReports
      : allReports.filter(r => r.status === (VALID_STATUSES.has(statusFilter) ? statusFilter : 'open'));

    res.json({ ok: true, reports, patterns });
  } catch (err) {
    console.error('[roommate-safety-reports] GET /admin failed', err);
    res.status(500).json({ ok: false, error: 'Could not load reports' });
  }
});

// PATCH /roommate-safety-reports/:id — founder marks a report reviewed (or
// reopens it). This is acknowledgment only — banning/unbanning a user stays
// on the existing general moderation system (AdminSafetyAPI /admin/safety/*),
// so this dataset doesn't grow a second, competing ban mechanism.
router.patch('/:id', requireAuth, requireFounder, async (req, res) => {
  try {
    await ensureTable();
    const { id } = req.params;
    const status = req.body?.status;
    if (!VALID_STATUSES.has(status)) {
      return res.status(400).json({ ok: false, error: `status must be one of: ${[...VALID_STATUSES].join(', ')}` });
    }
    const { rowCount } = await pool.query(
      `UPDATE roommate_safety_reports SET status = $1 WHERE id = $2`,
      [status, id],
    );
    if (rowCount === 0) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, status });
  } catch (err) {
    console.error('[roommate-safety-reports] PATCH failed', err);
    res.status(500).json({ ok: false, error: 'Could not update report' });
  }
});

module.exports = router;
