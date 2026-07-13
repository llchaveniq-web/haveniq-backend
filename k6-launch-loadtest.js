// k6 launch load-test — arrival-rate ramp on HavenIQ's hot read paths to find
// the measured capacity ceiling before the Ohio launch.
//
// Scenarios
//   • browse  (main): ramping-arrival-rate. Weights the three hot authenticated
//     reads — 45% GET /matches/feed, 35% GET /messages/conversations,
//     20% GET /quiz/progress — using RANDOM pre-minted bearer tokens (TOKENS
//     env), so it exercises the SERVER, not the signup/OTP limiter.
//     Ramp of offered req/s: 20 → 50 → 100 → 150 → 250 → 400 → 600.
//   • signup (optional): low constant-arrival-rate POST /auth/send-code with
//     throwaway lt_<vu>_<iter>_<ts>@<SIGNUP_TEST_DOMAIN> addresses. Only enabled
//     when SIGNUP_TEST_DOMAIN is set — and only run it with the auth limiter
//     RELAXED on staging (RATE_LIMIT_DISABLED=true), else you measure the
//     limiter. Counts ONLY 5xx as errors (a 429 there is the limiter doing its
//     job, not a server failure).
//
// NOTE on /quiz/progress: the spec named /quiz/questions, but the backend has no
// such route — quiz questions are bundled in the frontend. /quiz/progress is the
// equivalent authenticated quiz DB-read, so it stands in for that hot path.
//
// Thresholds double as the pass/fail gate: p95 < 2s AND browse error rate < 1%.
// k6 exits non-zero if breached. The ramp runs to completion (no abortOnFail) so
// you can read the last HEALTHY stage and see the cliff.
//
// RUN (staging only — verify the backend boot log shows the STAGING db host):
//   BASE_URL="https://<staging-backend>.up.railway.app" \
//   TOKENS="tokA,tokB,tokC,tokD,tokE" \
//   SIGNUP_TEST_DOMAIN="loadtest.haveniq.internal" \   # optional
//   k6 run k6-launch-loadtest.js

import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || '').replace(/\/+$/, '');
const TOKENS = (__ENV.TOKENS || '').split(',').map(t => t.trim()).filter(Boolean);
const SIGNUP_DOMAIN = (__ENV.SIGNUP_TEST_DOMAIN || '').trim();

if (!BASE_URL) throw new Error('Set BASE_URL to the STAGING backend URL.');
if (TOKENS.length === 0) throw new Error('Set TOKENS=comma,separated,bearer,tokens (from scripts/seed-loadtest.js).');

// Per-endpoint latency so you can see WHICH path led the degradation.
const latMatches       = new Trend('lat_matches', true);
const latConversations = new Trend('lat_conversations', true);
const latQuizQuestions = new Trend('lat_quiz_questions', true); // hits /quiz/progress
const appErrors        = new Rate('app_errors');       // browse-path errors
const signupErrors     = new Rate('signup_errors');    // 5xx-only on /auth/send-code

const scenarios = {
  browse: {
    executor: 'ramping-arrival-rate',
    exec: 'browse',
    startRate: 20,
    timeUnit: '1s',
    preAllocatedVUs: 200,
    maxVUs: 3000,          // let k6 add VUs as responses slow — that's the cliff
    stages: [
      { target: 20,  duration: '30s' },
      { target: 50,  duration: '1m' },
      { target: 100, duration: '1m' },
      { target: 150, duration: '1m' },
      { target: 250, duration: '1m' },   // model says pool-20 knee ≈ here
      { target: 400, duration: '1m' },
      { target: 600, duration: '1m' },
      { target: 0,   duration: '30s' },
    ],
  },
};

// Optional signup scenario — only when a throwaway domain is provided.
if (SIGNUP_DOMAIN) {
  scenarios.signup = {
    executor: 'constant-arrival-rate',
    exec: 'signup',
    rate: 2,               // gentle: 2 OTP requests/sec
    timeUnit: '1s',
    duration: '6m',        // spans the browse ramp
    preAllocatedVUs: 20,
    maxVUs: 100,
  };
}

export const options = {
  discardResponseBodies: true,
  scenarios,
  thresholds: {
    'http_req_duration': ['p(95)<2000'], // p95 < 2s
    'app_errors':        ['rate<0.01'],  // < 1% browse errors
    // signup_errors is informational (only present when the scenario runs).
    'signup_errors':     ['rate<0.05'],
  },
};

function authGet(path, trend) {
  const token = TOKENS[Math.floor(Math.random() * TOKENS.length)];
  const res = http.get(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { endpoint: path },
  });
  trend.add(res.timings.waiting);
  // Any non-2xx on an authenticated read is a capacity failure (503 pool
  // timeout, 500, or a 429 if the limiter wasn't relaxed).
  appErrors.add(res.status < 200 || res.status >= 300);
  check(res, { 'browse 2xx': r => r.status >= 200 && r.status < 300 });
  return res;
}

export function browse() {
  const r = Math.random();
  if (r < 0.45)      authGet('/matches/feed', latMatches);
  else if (r < 0.80) authGet('/messages/conversations', latConversations);
  else               authGet('/quiz/progress', latQuizQuestions);
}

export function signup() {
  const email = `lt_${__VU}_${__ITER}_${Date.now()}@${SIGNUP_DOMAIN}`;
  const res = http.post(`${BASE_URL}/auth/send-code`, JSON.stringify({ email }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { endpoint: '/auth/send-code' },
  });
  // Only 5xx is a server failure here; 429 is the limiter working as designed.
  signupErrors.add(res.status >= 500);
  check(res, { 'signup not 5xx': r => r.status < 500 });
}
