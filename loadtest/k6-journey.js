// k6 journey load test — realistic read/write mix (feed 40% / connect-write 25%
// / conversations 20% / quiz 15%) at a fixed arrival rate. Each connect consumes
// a known-valid, globally-unique (viewer,target) pair so it's a REAL INSERT, not
// a 4xx dedup. Run one RATE at a time; reset connect_requests between runs.
//
//   RATE=200 TOKENS="tokA,tokB,..." BASE_URL="https://<staging>" \
//     k6 run loadtest/k6-journey.js
//
// Healthy = p95 < 2s AND srv_err (5xx) < 1%. Sweep RATE up until it breaks.
import http from 'k6/http';
import exec from 'k6/execution';
import { Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const BASE = (__ENV.BASE_URL || '').replace(/\/+$/, '');
const TOKENS = (__ENV.TOKENS || '').split(',').map(t => t.trim()).filter(Boolean);
const RATE = parseInt(__ENV.RATE, 10) || 100;
const pairs = new SharedArray('pairs', () => JSON.parse(open('./pairs.json'))); // [[tokenIdx, targetId], ...]

const srvErr = new Rate('srv_err');
const connOk = new Rate('connect_ok');

export const options = {
  discardResponseBodies: true,
  scenarios: { step: { executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: __ENV.DURATION || '25s',
    preAllocatedVUs: Math.max(100, RATE * 4), maxVUs: Math.max(600, RATE * 20) } },
  thresholds: { srv_err: ['rate<0.01'], http_req_duration: ['p(95)<2000'] },
};

const rtok = () => TOKENS[Math.floor(Math.random() * TOKENS.length)];

export default function () {
  const r = Math.random();
  let res;
  if (r < 0.40) res = http.get(`${BASE}/matches/feed`, { headers: { Authorization: `Bearer ${rtok()}` } });
  else if (r < 0.65) {
    const [ti, target] = pairs[exec.scenario.iterationInTest % pairs.length];
    res = http.post(`${BASE}/matches/connect`, JSON.stringify({ toUserId: target }),
      { headers: { Authorization: `Bearer ${TOKENS[ti]}`, 'Content-Type': 'application/json' } });
    connOk.add(res.status >= 200 && res.status < 300);
  } else if (r < 0.85) res = http.get(`${BASE}/messages/conversations`, { headers: { Authorization: `Bearer ${rtok()}` } });
  else res = http.get(`${BASE}/quiz/progress`, { headers: { Authorization: `Bearer ${rtok()}` } });
  srvErr.add(res.status === 0 || res.status >= 500);
}
