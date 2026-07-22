# httpOnly session-cookie migration — runbook

**Goal:** move the web session token out of `localStorage` (readable by any JS,
so an XSS could steal it) into an **httpOnly + Secure cookie** the browser will
not expose to JavaScript at all. After this, a stolen-token XSS is off the table.

**Status:** the API is now on the same-site subdomain `api.haveniq.org`, so the
backend cookie support is **active by default** — every login also `Set-Cookie`s
`hq_session` and the CSRF guard is live. It ships **additively**: the body token
is still returned and bearer is still accepted, so **nothing changes for anyone
until the web client opts in** with `EXPO_PUBLIC_COOKIE_AUTH=true` (frontend, the
only remaining flip). Backend kill-switch: `COOKIE_AUTH_ENABLED=false`.

---

## Why it isn't just "flip a flag"

The cookie must be **first-party** to be sent by Safari and future Chrome. That
requires the API to be on a **same-site subdomain of the app**:

- App is at `haveniq.org` / `app.haveniq.org`.
- API is currently at `haveniq-backend-production.up.railway.app` — a **different
  registrable domain**, so a cookie it sets is a **third-party cookie**, which
  Safari ITP blocks today and Chrome is phasing out. Login would break.
- Fix: put the API on **`api.haveniq.org`** (a subdomain of your own domain).
  Then the cookie is first-party (`SameSite=Lax`) and works everywhere.

---

## What's implemented (active on the backend)

**Backend**
- `src/lib/sessionCookie.js` — `setSessionCookie` / `clearSessionCookie` /
  `readTokenCookie`. `setSessionCookie` sets `hq_session` (`HttpOnly; Secure;
  SameSite=Lax; Path=/`, host-only unless `COOKIE_DOMAIN` is set) **by default**;
  no-op only if `COOKIE_AUTH_ENABLED=false`.
- `src/middleware/auth.js` — `requireAuth`/`optionalAuth` read the token from the
  `Authorization` header **or** the `hq_session` cookie (header always wins;
  invalid/expired → **401**, never 403). `csrfGuard` (mounted globally in
  `server.js`) is **active by default**: a state-changing request that carries the
  cookie must also send `X-HavenIQ-CSRF` or it's 403. Bearer/webhook/GET exempt.
- `server.js` CORS: `credentials:true`, exact-origin reflection (never `*`), and
  `allowedHeaders` includes `X-HavenIQ-CSRF` so the preflight the custom header
  forces succeeds for our origin and fails for others.
- Cookie is set at **every** token-issuing point: `POST /auth/verify-code` (OTP
  login **and** signup completion), `POST /auth/refresh`, and both 2FA-challenge
  paths in `routes/twoFactor.js`.
- `POST /auth/logout` — clears the cookie (idempotent 200; an httpOnly cookie can
  only be cleared server-side).
- Tests: `src/middleware/authCookie.test.js` (unit) + `src/routes/authCookie.http.test.js`
  (end-to-end: cookie login/attrs, cookie-only `/users/me`, CSRF 403/allow,
  garbage→401, logout, bearer-still-works, CORS preflight allow/deny).

**Frontend**
- `services/api.ts` — when `EXPO_PUBLIC_COOKIE_AUTH=true`, the central API client
  sends `credentials:'include'` (so the cookie rides along) and an
  `X-HavenIQ-CSRF` header (required by `csrfGuard` on cookie-authed mutations).
- `constants/api.ts` — `API_BASE` is already env-driven (`EXPO_PUBLIC_API_BASE`),
  so pointing at `api.haveniq.org` is just an env var.

---

## The flip — do it in this order

### 1. Stand up `api.haveniq.org` (ops, ~5 min)
- **Railway** → backend service → Settings → Networking → **Add custom domain** →
  `api.haveniq.org`. Copy the CNAME target Railway shows.
- **Cloudflare** DNS → add `CNAME` `api` → that target. (Start **DNS-only / grey
  cloud**; switch to proxied only after Railway's cert is issued and green.)
- Verify: `curl https://api.haveniq.org/health` returns `{"ok":true,...}`.

### 2. Backend env (Railway)
- `COOKIE_AUTH_ENABLED` — **leave unset** (cookie auth is on by default). Set to
  `false` only as an emergency backend revert.
- `COOKIE_DOMAIN` — **leave unset** (preferred: host-only cookie scoped to
  `api.haveniq.org`). Set to `.haveniq.org` only if you actually need the cookie
  shared across other subdomains.
- `CLIENT_URL=https://app.haveniq.org` (and any other exact app origins, comma-
  separated). **Must not be `*`** — credentialed CORS requires an exact origin.
- The CORS block sets `credentials:true` when the origin list isn't `*` and
  allow-lists `X-HavenIQ-CSRF`.

### 3. Frontend cutover (the part NOT pre-built — needs live testing)
Do these **with the subdomain live** so you can test on real Safari + Chrome:
1. Build with `EXPO_PUBLIC_API_BASE=https://api.haveniq.org` and
   `EXPO_PUBLIC_COOKIE_AUTH=true`.
2. **Phase C — the actual security win:** stop persisting the token in
   `localStorage` on web, and change `stores/authStore.ts` `restoreSession` to
   detect an existing session by calling an authed endpoint (e.g. `GET /users/me`,
   which now rides the cookie) instead of reading a stored token. On web, `signOut`
   must call `POST /auth/logout` to clear the cookie (JS can't). Native (SecureStore)
   is unchanged and keeps using the bearer token.
3. Audit **inline `fetch`** calls that hit the API directly (they bypass the
   central client): e.g. `app/(tabs)/matches.tsx` signup-stats, `app/thread/[id].tsx`
   message-report, `submitReport`. Each authed mutation needs `credentials:'include'`
   + the `X-HavenIQ-CSRF` header — or, better, route them through `services/api.ts`.
   `wss:` socket auth also needs to move off the query-token to the cookie.
4. Update the frontend CSP `connect-src` (in the app's `_headers` / build) to
   include `https://api.haveniq.org` (and `wss://api.haveniq.org`).

### 4. Verify (before announcing)
- Sign in on **Safari (iPhone)** and **Chrome**: DevTools → Application → Cookies →
  `hq_session` present, **HttpOnly ✓ Secure ✓ SameSite=Lax**.
- `localStorage` no longer contains the token.
- Refresh the page → still signed in (session restored via the cookie).
- Sign out → cookie cleared, `GET /users/me` now 401s.
- A cross-site `fetch` from another origin can't read any authed response (CORS).

### Rollback
Ship a frontend build with `EXPO_PUBLIC_COOKIE_AUTH` unset — the web client goes
back to sending the bearer token and stops sending the cookie/CSRF header, so the
backend's Set-Cookie is simply ignored. The header-based bearer path never went
away, so this reverts cleanly with no backend change. (If you also want the
backend to stop setting the cookie entirely, set `COOKIE_AUTH_ENABLED=false`.)

---

## Notes
- `csrfGuard` only enforces on requests that **carry the `hq_session` cookie** —
  webhooks (Stripe/identity), pre-login OTP, and native bearer clients are never
  affected.
- Do **not** shorten the JWT TTL / refresh window to "harden" — it risks
  regressing the no-false-logout behavior (returning users skip login).
- Keep HSTS on (it is) — the `Secure` cookie is only sent over HTTPS.
