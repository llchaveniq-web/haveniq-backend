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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS roommate_safety_reports (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reported_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category    TEXT NOT NULL,
      detail      TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_safety_reports_reported ON roommate_safety_reports(reported_id);
    CREATE INDEX IF NOT EXISTS idx_safety_reports_reporter ON roommate_safety_reports(reporter_id);
  `).catch((e) => console.error('[roommate-safety-reports] ensure table:', e.message));
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

    const { rows } = await pool.query(
      `INSERT INTO roommate_safety_reports (reporter_id, reported_id, category, detail)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [reporterId, reportedId, category, (detail || '').slice(0, 2000)],
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

// GET /roommate-safety-reports/admin — the safety-team view. Surfaces PATTERNS
// (same reported_id, DISTINCT reporter_ids): one student reported by several
// different people is the signal worth immediate attention.
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
    const { rows: reports } = await pool.query(
      `SELECT
         r.id, r.category, r.detail, r.created_at,
         reporter.id AS reporter_id, reporter.first_name AS reporter_first_name,
         reported.id AS reported_id, reported.first_name AS reported_first_name
       FROM roommate_safety_reports r
       JOIN users reporter ON reporter.id = r.reporter_id
       JOIN users reported ON reported.id = r.reported_id
       ORDER BY r.created_at DESC`,
    );

    const byReported = new Map();
    for (const r of reports) {
      const bucket = byReported.get(r.reported_id)
        ?? { reportedId: r.reported_id, name: r.reported_first_name, reporterIds: new Set() };
      bucket.reporterIds.add(r.reporter_id);
      byReported.set(r.reported_id, bucket);
    }
    const patterns = [...byReported.values()]
      .filter(b => b.reporterIds.size > 1)
      .map(b => ({ reportedId: b.reportedId, name: b.name, distinctReporterCount: b.reporterIds.size }))
      .sort((a, b) => b.distinctReporterCount - a.distinctReporterCount);

    res.json({ ok: true, reports, patterns });
  } catch (err) {
    console.error('[roommate-safety-reports] GET /admin failed', err);
    res.status(500).json({ ok: false, error: 'Could not load reports' });
  }
});

module.exports = router;
