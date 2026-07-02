// ═══════════════════════════════════════════════════════════════════════════
//  One-click unsubscribe for LIFECYCLE (marketing) email — the G1 sender.
//
//  GET  /unsubscribe?token=…  — a human clicking the footer link; shows a page.
//  POST /unsubscribe?token=…  — RFC 8058 one-click (List-Unsubscribe-Post); the
//                               mail client POSTs it automatically.
//
//  The signed token IS the auth (no login). On a valid 'lifecycle' token we set
//  users.lifecycle_opted_out = TRUE — the SAME flag the sender's eligibility
//  query excludes — then confirm. Idempotent (clicking twice is fine). Only
//  touches lifecycle mail; transactional email (login codes) is a separate path
//  and never consults this flag. An invalid/expired token changes nothing.
// ═══════════════════════════════════════════════════════════════════════════
const router = require('express').Router();
const pool = require('../db/pool');
const { verify } = require('../lib/unsubscribeToken');

function page(message, ok) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HavenIQ — ${ok ? 'Unsubscribed' : 'Unsubscribe'}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#FBF1EA;margin:0;padding:48px 20px;color:#2D2620;">
  <div style="max-width:460px;margin:0 auto;background:#fff;border-radius:20px;padding:36px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
    <p style="font-size:24px;font-weight:800;color:#A33625;margin:0 0 16px;">HavenIQ ✦</p>
    <p style="font-size:16px;line-height:1.6;margin:0;">${message}</p>
    ${ok ? '<p style="font-size:13px;color:#75695A;margin:18px 0 0;">You may still receive essential account emails (like sign-in codes).</p>' : ''}
  </div>
</body></html>`;
}

// Both verbs share one handler; the token (query string) is the same for each.
async function handle(req, res) {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const decoded = verify(token, 'lifecycle');
  if (!decoded) {
    // Invalid/expired → reject, change NOTHING.
    return res.status(400).type('html').send(page('This unsubscribe link is invalid or has expired. Nothing was changed. If you need help, email support@haveniq.org.', false));
  }
  try {
    // Idempotent: TRUE again is a no-op; COALESCE keeps the FIRST opt-out time.
    await pool.query(
      'UPDATE users SET lifecycle_opted_out = TRUE, lifecycle_opted_out_at = COALESCE(lifecycle_opted_out_at, NOW()) WHERE id = $1',
      [decoded.userId],
    );
  } catch (e) {
    console.error('[unsubscribe] opt-out write failed:', e.message);
    return res.status(500).type('html').send(page('Something went wrong on our end. Please email support@haveniq.org and we\'ll remove you.', false));
  }
  return res.status(200).type('html').send(page("You're unsubscribed from HavenIQ nudges. You won't get any more of these.", true));
}

router.get('/unsubscribe', handle);
router.post('/unsubscribe', handle);

module.exports = router;
