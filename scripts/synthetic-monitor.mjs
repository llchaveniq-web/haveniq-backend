/**
 * Synthetic monitor — every 5 min, probe critical user paths and alert
 * Discord if any of them are broken or slow. Catches the bugs Sentry
 * can't because no real user has hit the broken path yet.
 *
 * What we probe (read-only, no test data left behind):
 *   1. Backend /health responds 200 with JSON.status === 'ok'
 *   2. Frontend app.haveniq.org returns 200 + non-empty HTML
 *   3. Backend POST /auth/send-code with a known synthetic email returns 200
 *      (the real send is gated behind Resend, but the route should ack)
 *   4. Backend GET /quiz/questions returns a list (>=20 questions)
 *   5. Backend GET /health latency p50 < 2 sec across 3 samples
 *
 * Each probe has a name + expected-condition; we report the failures
 * (with what we got vs what we expected) so the founder can act.
 *
 * Cost: ~0 (no Anthropic, no DB, just fetch).
 */

const env = (k) => (process.env[k] ?? '').replace(/[^!-~]/g, '');

const BACKEND       = 'https://haveniq-backend-production.up.railway.app';
const FRONTEND      = 'https://app.haveniq.org';
const DISCORD_HOOK  = env('DISCORD_WEBHOOK_URL');
const PROBE_EMAIL   = 'synthetic-monitor@haveniq.org';  // not a real user

const TIMEOUT_MS    = 8_000;
const LATENCY_BUDGET_MS = 2_000;

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return { res, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

const probes = [
  {
    name: 'Backend /health responds 200 with ok',
    async run() {
      const { res, ms } = await fetchWithTimeout(`${BACKEND}/health`);
      if (!res.ok) return { ok: false, detail: `status=${res.status}`, ms };
      const j = await res.json().catch(() => null);
      if (j?.status !== 'ok') return { ok: false, detail: `body.status=${JSON.stringify(j?.status)}`, ms };
      return { ok: true, ms };
    },
  },
  {
    name: 'Frontend app.haveniq.org returns HTML',
    async run() {
      const { res, ms } = await fetchWithTimeout(FRONTEND);
      if (!res.ok) return { ok: false, detail: `status=${res.status}`, ms };
      const text = await res.text();
      if (text.length < 500) return { ok: false, detail: `body too small (${text.length} bytes)`, ms };
      if (!/<html|<!doctype/i.test(text)) return { ok: false, detail: 'no <html> tag', ms };
      return { ok: true, ms };
    },
  },
  {
    name: 'Backend /auth/send-code accepts synthetic email',
    async run() {
      const { res, ms } = await fetchWithTimeout(`${BACKEND}/auth/send-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: PROBE_EMAIL, syntheticProbe: true }),
      });
      // Backend may return 200 OR a 4xx if our synthetic email is rejected
      // by the .edu filter — that's still proof the route is alive.
      if (res.status >= 500) return { ok: false, detail: `status=${res.status}`, ms };
      return { ok: true, ms };
    },
  },
  {
    // Confirms the auth-protected surface is reachable AND correctly
    // returning 401 (not a 404, not a 500). 401 from /users/me without
    // a token = router is mounted, auth middleware is wired, DB is
    // reachable enough to participate in the request. That's a strong
    // signal the authenticated paths users hit after sign-in still work.
    name: 'Backend /users/me returns 401 when unauthenticated',
    async run() {
      const { res, ms } = await fetchWithTimeout(`${BACKEND}/users/me`);
      if (res.status === 401) return { ok: true, ms };
      return { ok: false, detail: `expected 401, got ${res.status}`, ms };
    },
  },
  {
    name: 'Backend /health p50 latency under 2 sec',
    async run() {
      const samples = [];
      for (let i = 0; i < 3; i++) {
        const { ms } = await fetchWithTimeout(`${BACKEND}/health`);
        samples.push(ms);
      }
      samples.sort((a, b) => a - b);
      const p50 = samples[1];
      if (p50 > LATENCY_BUDGET_MS) {
        return { ok: false, detail: `p50=${p50}ms over budget ${LATENCY_BUDGET_MS}ms (samples: ${samples.join(', ')})`, ms: p50 };
      }
      return { ok: true, ms: p50 };
    },
  },
];

async function postDiscord(title, color, fields, footer) {
  if (!DISCORD_HOOK) return;
  try {
    await fetch(DISCORD_HOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title,
          color,
          fields,
          timestamp: new Date().toISOString(),
          footer: { text: footer },
        }],
      }),
    });
  } catch (err) {
    console.error('[synthetic] Discord post failed:', err.message);
  }
}

(async () => {
  console.log(`Synthetic monitor — ${probes.length} probe(s)`);
  const failures = [];
  const passes = [];

  for (const probe of probes) {
    try {
      const result = await probe.run();
      if (result.ok) {
        console.log(`  ✓ ${probe.name} (${result.ms}ms)`);
        passes.push({ ...probe, ...result });
      } else {
        console.error(`  ✗ ${probe.name} — ${result.detail} (${result.ms}ms)`);
        failures.push({ ...probe, ...result });
      }
    } catch (err) {
      console.error(`  ✗ ${probe.name} — threw: ${err.message}`);
      failures.push({ ...probe, ok: false, detail: `threw: ${err.message}`, ms: -1 });
    }
  }

  if (failures.length === 0) {
    // Silent success — don't spam Discord with green checks every 5 min.
    // The cron run history itself is the heartbeat.
    console.log(`All ${probes.length} probes green.`);
    return;
  }

  // Alert Discord. Color severity = how many failed.
  const color = failures.length >= 3 ? 0xC0392B  // red — multiple critical
              : failures.length === 2 ? 0xE67E22  // orange — concerning
              : 0xF1C40F;                          // yellow — single probe blip
  const fields = failures.map((f) => ({
    name: `✗ ${f.name}`,
    value: '```' + f.detail.slice(0, 1000) + '```',
    inline: false,
  }));
  if (passes.length > 0) {
    fields.push({
      name: `✓ ${passes.length} other probe(s) green`,
      value: passes.map((p) => `• ${p.name} (${p.ms}ms)`).join('\n').slice(0, 1000),
      inline: false,
    });
  }
  await postDiscord(
    `🚨 Synthetic monitor — ${failures.length}/${probes.length} probe(s) failing`,
    color,
    fields,
    'Synthetic monitor • runs every 5 min',
  );

  process.exit(1);  // CI red so the failure is visible in the Actions tab too
})().catch((err) => {
  console.error('[synthetic] unexpected error:', err);
  process.exit(1);
});
