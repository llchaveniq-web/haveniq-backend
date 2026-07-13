# Staging load-test runbook (University of Ohio launch)

Goal: measure the real `GET /matches/feed` req/s ceiling on a staging copy of
production, and confirm raising `PG_POOL_MAX` moves it. **Never load-test
production** — a k6 ramp will saturate the pool and degrade real users.

There is **no staging environment yet** — step 1 creates one. Everything after
is turnkey.

---

## 1. Stand up staging on Railway (one-time, ~15 min)

Staging must mirror production's schema on a **separate database** so the test
can't touch real data.

1. **New Railway service** from the same GitHub repo (`haveniq-backend`), e.g. a
   `staging` environment or a second service. Point it at a branch you control
   (`main` is fine — same code as prod).
2. **New Postgres** (Railway → Add → Database → PostgreSQL) *in that staging
   environment*. This is the separate DB. Do **not** reuse the prod database.
3. **Env vars on the staging service** (copy prod's, then override):
   - `DATABASE_URL` → the **staging** Postgres (Railway usually injects this
     via a reference variable when the DB is in the same environment).
   - `JWT_SECRET` → any ≥32-char secret. Note it — the seed script must use the
     **same** value so its tokens verify.
   - `NODE_ENV=production` (so SSL/cookies behave like prod).
   - `RATE_LIMIT_DISABLED=true` ← **staging only.** Relaxes all limiters for the
     ramp. The boot log prints a loud banner confirming it.
   - `PG_POOL_MAX` → leave unset (defaults to 20) for the baseline run; raise
     later to compare.
   - Any other secrets prod needs to boot (Resend, Stripe, etc.) — test-mode or
     dummy values are fine; the feed endpoint doesn't call them.
4. **Schema:** the app applies `schema.sql` + `migrate_missing.sql` on boot, so
   the staging DB gets the full schema (incl. the new launch-capacity indexes)
   the first time the service starts. Confirm via the health check below.
5. Note the staging base URL Railway assigns (e.g.
   `https://haveniq-backend-staging.up.railway.app`, or a custom
   `staging.api.haveniq.org` if you add one).

**Verify staging is up (schema applied, DB reachable):**
```bash
curl https://<staging-base-url>/health
# → {"ok":true,"status":"ok","db":"up","commit":"…"}
```

## 2. Seed test users + get tokens + the two diagnostics

Run locally, pointed at **staging** (values from step 1). This writes 4 test
users, mints bearer tokens, and prints `max_connections` + the feed
`EXPLAIN ANALYZE`:

```bash
DATABASE_URL='<staging DATABASE_URL>' \
JWT_SECRET='<staging JWT_SECRET>' \
ALLOW_TEST_SEED=true \
node scripts/seed-staging-loadtest.js 4
```

Copy the 4 tokens it prints. (It refuses to run without `ALLOW_TEST_SEED=true`,
and prints the target DB host first so you can confirm it's staging.)

> Feed depth: the tokens authenticate and exercise the full feed query
> regardless of result count. For a *realistic* result set, seed the staging DB
> with a candidate pool first (`src/db/seed_200_demo_users.sql` + a scoring
> pass) — but even a thin feed measures the same joins/scan the pool test cares
> about.

## 3. Run the k6 ramp

Install k6 (<https://k6.io/docs/get-started/installation/>), then:

```bash
BASE_URL='https://<staging-base-url>' \
TOKENS='<tok1>,<tok2>,<tok3>,<tok4>' \
k6 run scripts/k6-feed-ramp.js
```

The script (`scripts/k6-feed-ramp.js`) uses a **ramping-arrival-rate** executor:
it pushes a rising target req/s (20 → 300) and keeps pushing even as responses
slow, so the ceiling shows up as the point where `feed_failed` and
`http_req_duration p95` climb. Watch the end-of-run summary:
- **Healthy:** `feed_failed` ~0, p95 < ~800ms.
- **Ceiling:** the req/s stage where p95 spikes to seconds and errors climb.

## 4. Confirm the pool change moved the ceiling

Run the ramp twice, changing only the staging `PG_POOL_MAX` between runs (redeploy
or restart the service to pick it up):
- Run A: `PG_POOL_MAX=10` → expect the cliff near ~100 req/s.
- Run B: `PG_POOL_MAX=20` (default) → expect the cliff roughly doubled.

If B's ceiling is meaningfully higher than A's, the pool was the bottleneck and
the change helped. Push `PG_POOL_MAX` higher only while
`PG_POOL_MAX × replicas` stays safely under the staging DB's `max_connections`
(printed in step 2).

## 5. Tear down

- Delete the 4 `loadtest-*@haveniq-demo.edu` users if you like (they're already
  excluded from real feeds by the demo filter, so leaving them is harmless).
- **Before scaling prod past 1 replica:** move the rate-limit store to Redis, or
  per-IP/email limits multiply per replica. (In-memory is correct at 1 replica.)
- `RATE_LIMIT_DISABLED` lives only on staging — production never sets it.
