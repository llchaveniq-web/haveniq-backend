// ─── Audit log helper ────────────────────────────────────────────────────
//
// One-liner from any route handler:
//
//   const { audit } = require('../services/auditLog');
//   await audit(req, 'profile.patch', { fields: changedFields });
//
// Fire-and-forget by design — we never want auditing failures to break a
// user request. The await is for callers that want it; pass `.catch(()=>{})`
// to suppress promise warnings if you don't await.

const pool = require('../db/pool');

/**
 * Record one sensitive action a user took.
 *
 * @param req     Express request — used to pull req.user.id + req.ip + UA
 * @param action  Verb in "snake.dot" form (e.g. "account.delete")
 * @param details Optional small JSON object with action-specific context
 */
async function audit(req, action, details) {
  try {
    const userId = req.user?.id || null;
    // Truncate to keep the column small + privacy-friendly. We don't need
    // the whole UA string for forensics — just enough to recognize the
    // device class (mobile Safari vs Chrome vs cURL).
    const ua = (req.headers?.['user-agent'] || '').slice(0, 200) || null;
    await pool.query(
      `INSERT INTO audit_log (user_id, action, details, ip, user_agent)
       VALUES ($1, $2, $3::JSONB, $4, $5)`,
      [
        userId,
        String(action).slice(0, 100),
        details ? JSON.stringify(details) : null,
        req.ip || null,
        ua,
      ],
    );
  } catch (err) {
    // Never propagate audit failures. Log to stderr so we can grep
    // Railway logs if the audit table itself is broken.
    console.error('[audit] failed to write row:', err.message);
  }
}

module.exports = { audit };
