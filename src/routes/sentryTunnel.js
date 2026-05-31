/**
 * Sentry tunnel — POST /api/__report
 *
 * Receives Sentry SDK envelope POSTs from the frontend (configured via
 * Sentry.init({ tunnel: '<this URL>' })) and forwards them to Sentry's
 * ingest endpoint server-side.
 *
 * Why this exists: ad blockers (uBlock, AdBlock, Brave Shields) and
 * iOS Safari's built-in Cross-Site Tracking Prevention block direct
 * POSTs from the browser to sentry.io. That means errors from ~30-40%
 * of real users never reach Sentry — and our Tier 3 webhook + auto-fix
 * bot can't act on what Sentry doesn't see.
 *
 * Tunnel solves this. Frontend sends events to our own domain (which
 * ad blockers can't block — they're not allowed to block first-party
 * requests). Backend forwards to Sentry. From Sentry's view, it's
 * receiving normal events. From the browser's view, it's POSTing to
 * a normal API route on the same backend it already talks to.
 *
 * Sentry envelope format (newline-delimited JSON):
 *   { "dsn": "https://<key>@<host>/<projectId>", "sent_at": "..." }
 *   { "type": "event", "length": ... }
 *   { ...actual event payload... }
 *   { "type": "transaction", ... }   (optional more items)
 *   ...
 *
 * We parse the first line to get the DSN, then POST the entire raw
 * envelope to the matching ingest URL. Don't parse or modify the
 * payload itself — that would break Sentry's signature validation.
 *
 * Security: we only forward to the DSN host the SDK declares. An
 * attacker can't use this to proxy arbitrary requests because the
 * destination is constrained to .ingest.sentry.io / .ingest.us.sentry.io.
 */

const express = require('express');
const router  = express.Router();

const ALLOWED_HOSTS = /^(o[0-9]+\.)?ingest\.(us\.|eu\.|de\.)?sentry\.io$/i;

router.post(
  '/__report',
  // Sentry envelopes are NOT JSON — they're newline-delimited mixed
  // text. Parse as text so we get the raw body intact.
  express.text({ type: '*/*', limit: '2mb' }),
  async (req, res) => {
    try {
      const envelope = typeof req.body === 'string' ? req.body : '';
      if (!envelope) return res.status(400).json({ error: 'empty envelope' });

      // First line is the envelope header (JSON). Contains the DSN.
      const firstNewline = envelope.indexOf('\n');
      if (firstNewline < 0) return res.status(400).json({ error: 'malformed envelope' });
      const headerLine = envelope.slice(0, firstNewline);

      let header;
      try { header = JSON.parse(headerLine); }
      catch { return res.status(400).json({ error: 'envelope header not JSON' }); }

      if (!header.dsn) return res.status(400).json({ error: 'no dsn in envelope' });

      let dsnUrl;
      try { dsnUrl = new URL(header.dsn); }
      catch { return res.status(400).json({ error: 'malformed dsn' }); }

      if (!ALLOWED_HOSTS.test(dsnUrl.host)) {
        return res.status(400).json({ error: `dsn host ${dsnUrl.host} not allowed` });
      }

      const projectId = dsnUrl.pathname.replace(/^\//, '');
      if (!/^[0-9]+$/.test(projectId)) {
        return res.status(400).json({ error: 'malformed project id' });
      }

      const upstream = `https://${dsnUrl.host}/api/${projectId}/envelope/`;

      // Forward. Use a short timeout — if Sentry is slow we don't want to
      // hold the user's tab waiting.
      const upstreamRes = await fetch(upstream, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-sentry-envelope' },
        body:    envelope,
        signal:  AbortSignal.timeout(8_000),
      });

      // Don't relay the body back — Sentry's response is opaque to the
      // browser anyway. Just relay the status so the SDK's retry logic
      // knows whether to back off.
      res.status(upstreamRes.status).end();
    } catch (err) {
      console.error('[sentry-tunnel] forward failed:', err.message);
      res.status(502).json({ error: 'tunnel forward failed' });
    }
  }
);

// Health check — quick sanity probe.
// curl https://...railway.app/api/__report/health
router.get('/__report/health', (req, res) => {
  res.json({ ok: true, allowed_hosts: ALLOWED_HOSTS.toString() });
});

module.exports = router;
