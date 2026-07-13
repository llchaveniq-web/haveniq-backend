// k6 arrival-rate ramp against GET /matches/feed — finds the request/second
// ceiling so you can confirm the pool change (PG_POOL_MAX) moved it.
//
// WHY arrival-rate (not VUs): a fixed VU count backs off when the server slows,
// hiding the cliff. `ramping-arrival-rate` keeps *pushing* a target req/s no
// matter how slow responses get, so the failure point shows up as latency and
// errors climbing — exactly the pool-exhaustion cliff we're hunting.
//
// ── RUN ─────────────────────────────────────────────────────────────────────
//   Install k6 (https://k6.io/docs/get-started/installation/), then:
//
//     BASE_URL='https://staging.api.haveniq.org' \
//     TOKENS='<token1>,<token2>,<token3>,<token4>' \
//     k6 run scripts/k6-feed-ramp.js
//
//   TOKENS = comma-separated bearer tokens from scripts/seed-staging-loadtest.js.
//   Optional: PEAK_RPS (default 300), RAMP=stage list is fixed below — edit the
//   `stages` array to reshape the ramp.
//
//   Point this ONLY at staging with RATE_LIMIT_DISABLED=true, or the global
//   200/15min limiter caps you at ~0.2 req/s and you measure the limiter, not
//   the pool.

import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || '').replace(/\/+$/, '');
const TOKENS = (__ENV.TOKENS || '').split(',').map(t => t.trim()).filter(Boolean);
const PEAK_RPS = parseInt(__ENV.PEAK_RPS, 10) || 300;

if (!BASE_URL) throw new Error('Set BASE_URL, e.g. https://staging.api.haveniq.org');
if (TOKENS.length === 0) throw new Error('Set TOKENS=comma,separated,bearer,tokens');

const feedFail = new Rate('feed_failed');
const feedTTFB = new Trend('feed_ttfb', true);

export const options = {
  discardResponseBodies: true, // we only measure timing/status, not payloads
  scenarios: {
    feed_ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 20,             // req/s to begin
      timeUnit: '1s',
      preAllocatedVUs: 100,      // pool of VUs ready to fire the arrivals
      maxVUs: 2000,              // let k6 add VUs as responses slow (the cliff)
      stages: [
        { target: 50,        duration: '1m' },
        { target: 100,       duration: '1m' },   // ~expected old ceiling
        { target: 150,       duration: '1m' },
        { target: 200,       duration: '1m' },   // ~expected new ceiling (pool 20)
        { target: PEAK_RPS,  duration: '2m' },   // push past it to see the cliff
        { target: PEAK_RPS,  duration: '1m' },   // hold at peak
        { target: 0,         duration: '30s' },  // ramp down
      ],
    },
  },
  thresholds: {
    // Informational gates — the run still completes if they trip; they just
    // mark where the server stopped being healthy.
    feed_failed:        ['rate<0.01'],  // <1% errors = healthy
    'http_req_duration': ['p(95)<800'], // p95 under 800ms = healthy
  },
};

export default function () {
  // Rotate tokens so no single account/session is the bottleneck.
  const token = TOKENS[(__VU + __ITER) % TOKENS.length];
  const res = http.get(`${BASE_URL}/matches/feed`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { endpoint: 'matches_feed' },
  });
  feedFail.add(res.status !== 200);
  feedTTFB.add(res.timings.waiting);
  check(res, {
    'status is 200': r => r.status === 200,
    'not rate-limited (429)': r => r.status !== 429,
  });
}
