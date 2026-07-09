# httpOnly session-cookie migration — runbook

**Goal:** move the web session token out of `localStorage` (readable by any JS,
so an XSS could steal it) into an **httpOnly + Secure cookie** the browser will
not expose to JavaScript at all. After this, a stolen-token XSS is off the table.

**Status:** the plumbing is built and shipped **inert**, gated on
`COOKIE_AUTH_ENABLED` (backend) and `EXPO_PUBLIC_COOKIE_AUTH` (frontend), both
default OFF. Nothing changes in production until you complete the steps below.

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

## What's already built (shipped, inert)

**Backend**
- `src/lib/sessionCookie.js` — `setSessionCookie` / `clearSessionCookie` /
  `readTokenCookie`. `setSessionCookie` is a **no-op unless `COOKIE_AUTH_ENABLED=true`**.
- `src/middleware/auth.js` — `requireAuth`/`optionalAuth` now read the token from
  the `Authorization` header **or** the `hq_session` cookie (header always wins).
  New `csrfGuard` (mounted globally in `server.js`) — inert unless the flag is on.
- Cookie is set at **every** token-issuing point: `POST /auth` (OTP login),
  `POST /auth/refresh`, and both 2FA-completion paths in `routes/twoFactor.js`.
- New `POST /auth/logout` — clears the cookie (an httpOnly cookie can only be
  cleared server-side).
- Tests: `src/middleware/authCookie.test.js` (token precedence, CSRF gating,
  cookie attributes).

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
- `COOKIE_AUTH_ENABLED=true`
- `COOKIE_DOMAIN=.haveniq.org`  (leading dot → shared across app + api subdomains)
- `CLIENT_URL=https://app.haveniq.org` (and any other exact app origins, comma-
  separated). **Must not be `*`** — credentialed CORS requires an exact origin.
- Redeploy. The CORS block already sets `credentials:true` when the origin list
  isn't `*`.

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
Set `COOKIE_AUTH_ENABLED=false` (backend) and ship a frontend build with
`EXPO_PUBLIC_COOKIE_AUTH` unset. The header-based bearer path never went away, so
this reverts cleanly.

---

## Notes
- `csrfGuard` only enforces on requests that **carry the `hq_session` cookie** —
  webhooks (Stripe/identity), pre-login OTP, and native bearer clients are never
  affected.
- Do **not** shorten the JWT TTL / refresh window to "harden" — it risks
  regressing the no-false-logout behavior (returning users skip login).
- Keep HSTS on (it is) — the `Secure` cookie is only sent over HTTPS.
