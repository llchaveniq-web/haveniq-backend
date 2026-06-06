/**
 * Walk Score proxy.
 *
 * Keeps the Walk Score API key SERVER-SIDE (never shipped to the browser) and
 * sidesteps CORS — the web app calls our backend, we call Walk Score.
 *
 *   GET /walkscore?address=<str>&lat=<num>&lon=<num>
 *     → 200 { walk, walkDesc, transit, transitDesc, bike, bikeDesc }
 *     → 200 { pending: true }            (Walk Score still computing; retry later)
 *     → 503 { error: 'not_configured' }  (no WALKSCORE_KEY set in the environment)
 *     → 502 { error: 'upstream' }        (Walk Score unreachable / bad response)
 *
 * Public (no auth) — it returns only neighborhood data, never anything
 * user-specific. Set WALKSCORE_KEY in the Railway environment to enable.
 */
const router = require('express').Router();

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

router.get('/', async (req, res) => {
  const key = process.env.WALKSCORE_KEY;
  if (!key) return res.status(503).json({ error: 'not_configured' });

  const address = typeof req.query.address === 'string' ? req.query.address : '';
  const lat = num(req.query.lat);
  const lon = num(req.query.lon);
  if (lat === null || lon === null) {
    return res.status(400).json({ error: 'lat and lon are required' });
  }

  const url =
    `https://api.walkscore.com/score?format=json` +
    `&address=${encodeURIComponent(address)}` +
    `&lat=${lat}&lon=${lon}&transit=1&bike=1&wsapikey=${key}`;

  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!upstream.ok) return res.status(502).json({ error: 'upstream' });
    const d = await upstream.json();

    // Walk Score status: 1 = OK, 2 = score being calculated (retry), else error.
    if (d.status === 2) return res.json({ pending: true });
    if (d.status !== 1) return res.status(502).json({ error: 'upstream', status: d.status });

    return res.json({
      walk: typeof d.walkscore === 'number' ? d.walkscore : null,
      walkDesc: typeof d.description === 'string' ? d.description : '',
      transit: d.transit && typeof d.transit.score === 'number' ? d.transit.score : null,
      transitDesc: d.transit && typeof d.transit.description === 'string' ? d.transit.description : '',
      bike: d.bike && typeof d.bike.score === 'number' ? d.bike.score : null,
      bikeDesc: d.bike && typeof d.bike.description === 'string' ? d.bike.description : '',
    });
  } catch {
    return res.status(502).json({ error: 'upstream' });
  }
});

module.exports = router;
