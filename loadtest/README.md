# Re-running the capacity load test (next campus)

Measures the real request/second ceiling of the API under a realistic full-journey
mix (feed + connect writes + conversations + quiz), on **staging**, never prod.

## ⚠️ Before anything: know your DB hosts
Railway `talented-peace` project. **Verify with `railway variables -e <env> -s Postgres`.**
- **PRODUCTION Postgres** = `yamanote.proxy.rlwy.net:35621` — NEVER seed/load-test this.
- **STAGING Postgres** = `hayabusa.proxy.rlwy.net:29697` — use this. (Get its full
  public URL from `railway variables -e staging -s Postgres` → `DATABASE_PUBLIC_URL`,
  or build it: `postgresql://postgres:<POSTGRES_PASSWORD>@hayabusa.proxy.rlwy.net:29697/railway`.)

Set once (used by the node steps below):
```bash
export STAGING_URL='postgresql://postgres:<pw>@hayabusa.proxy.rlwy.net:29697/railway'
export STAGING_BASE='https://haveniq-backend-staging.up.railway.app'
```

## 1. Rebuild + deploy staging (staging is empty/stale between runs)
```bash
DATABASE_URL="$STAGING_URL" ALLOW_STAGING_REBUILD=true node loadtest/rebuild-staging-schema.js
railway variables --set "RATE_LIMIT_DISABLED=true" --set "PG_POOL_MAX=40" -e staging -s haveniq-backend
railway up -e staging -s haveniq-backend --ci      # deploys current code; DON'T use `railway redeploy` (stale env)
```
Confirm the flag actually took effect (or the test measures the limiter, not the pool):
```bash
railway logs -e staging -s haveniq-backend | grep "limiters are OFF"   # must print the banner
```

## 2. Seed + prep
```bash
ALLOW_TEST_SEED=true JWT_SECRET=x_pad_to_32_chars_xxxxxxxxxxxxxxx DATABASE_URL="$STAGING_URL" \
  USER_COUNT=2000 VIEWER_COUNT=20 node scripts/seed-loadtest.js
DATABASE_URL="$STAGING_URL" VIEWER_COUNT=20 node loadtest/prep-loadtest.js   # writes loadtest/pairs.json + viewer-ids.txt
```

## 3. Mint valid tokens (JWT_SECRET never leaves Railway)
```bash
railway run -e staging -s haveniq-backend node scripts/mint-loadtest-tokens.js $(cat loadtest/viewer-ids.txt) \
  | sed -n 's/^TOKENS=//p' > loadtest/tokens.txt
```

## 4. Sweep (needs k6 — https://k6.io/docs/get-started/installation/)
Reset connect_requests between each rate so every connect is a fresh INSERT:
```bash
export TOKENS="$(paste -sd, loadtest/tokens.txt)"
for RATE in 50 100 200 300 400 500 600 700; do
  node -e 'const {Pool}=require("pg");new Pool({connectionString:process.env.STAGING_URL,ssl:{rejectUnauthorized:false}}).query("delete from connect_requests").then(()=>process.exit())'
  echo "== $RATE req/s =="
  RATE=$RATE BASE_URL="$STAGING_BASE" k6 run --quiet loadtest/k6-journey.js 2>&1 | grep -E "http_req_duration|srv_err|connect_ok"
done
```
**Healthy** = the highest rate where `http_req_duration p(95) < 2s` AND `srv_err < 1%`.
Translate to users: `healthy_req_s ÷ 0.125 ≈ concurrent active users` (~1 req / 8s each).

## 5. Teardown
```bash
node -e 'const {Pool}=require("pg");new Pool({connectionString:process.env.STAGING_URL,ssl:{rejectUnauthorized:false}}).query("delete from users where email like '"'"'%@loadtest.ohio.edu'"'"'").then(()=>process.exit())'
```

## Baseline (2026-07-13, Ohio, staging pool 40)
Healthy to **~300 req/s** (p95 141ms, 0 errors, 100% writes) → ~2,400 concurrent users.
Feed degrades first (heaviest query). Prod is stronger (500 vs 100 max_connections) and
now runs `PG_POOL_MAX=80`, so its ceiling is ~2× this. Match staging's pool to prod's
before comparing.
