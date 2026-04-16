# HavenIQ Backend — Deploy in 30 Minutes

## Step 1 — Push to GitHub (5 min)

1. Go to github.com → New repository → name it `haveniq-backend` → Create
2. Open PowerShell in `C:\Users\jbern\HavenIQ-Backend\`:

```
git init
git add .
git commit -m "HavenIQ backend v1.0"
git remote add origin https://github.com/YOUR_USERNAME/haveniq-backend.git
git push -u origin main
```

---

## Step 2 — Deploy on Railway (10 min, free)

1. Go to **railway.app** → Sign up with GitHub
2. Click **New Project** → **Deploy from GitHub repo** → select `haveniq-backend`
3. Railway auto-detects Node.js and deploys it

### Add PostgreSQL database:
- In your Railway project → **New** → **Database** → **PostgreSQL**
- Click the database → **Connect** tab → copy the `DATABASE_URL`

### Add environment variables:
- Click your service → **Variables** tab → add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | (paste from Railway PostgreSQL) |
| `JWT_SECRET` | (any long random string, 64+ chars) |
| `SENDGRID_API_KEY` | (from sendgrid.com — free tier = 100 emails/day) |
| `FROM_EMAIL` | noreply@haveniq.com |
| `FROM_NAME` | HavenIQ |
| `NODE_ENV` | production |
| `CLIENT_URL` | * |

### Run the database schema:
- Railway dashboard → PostgreSQL → **Query** tab
- Paste the entire contents of `src/db/schema.sql` → Run

---

## Step 3 — Get your live URL (instant)

Railway gives you a URL like:
```
https://haveniq-backend-production.up.railway.app
```

Test it:
```
curl https://YOUR_URL.up.railway.app/health
```
Should return: `{"status":"ok","version":"1.0.0",...}`

---

## Step 4 — Connect the app (10 min)

Create `C:\Users\jbern\HavenIQ-App\constants\api.ts`:

```ts
export const API_BASE = 'https://YOUR_URL.up.railway.app';
export const WS_URL   = 'wss://YOUR_URL.up.railway.app';
```

Then update `stores/authStore.ts` to call real endpoints:

```ts
// Replace mock signIn with:
const res = await fetch(`${API_BASE}/auth/verify-code`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, code, school, schoolDomain }),
});
const data = await res.json();
await SecureStore.setItemAsync('auth_token', data.token);
```

---

## Step 5 — SendGrid setup (5 min)

1. Go to **sendgrid.com** → Sign up free (100 emails/day free)
2. Settings → API Keys → Create API Key → Full Access
3. Paste the key as `SENDGRID_API_KEY` in Railway
4. Sender Authentication → verify your email domain

---

## Cost (free to start)

| Service | Free tier |
|---|---|
| Railway | $5/mo credit (usually enough for MVP) |
| PostgreSQL on Railway | Included |
| SendGrid | 100 emails/day free |
| Expo push notifications | Free |

**Total monthly cost to launch: ~$0–5**

---

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/send-code` | No | Send OTP to .edu email |
| POST | `/auth/verify-code` | No | Verify OTP, get JWT |
| GET | `/users/me` | Yes | Get my profile |
| PATCH | `/users/me` | Yes | Update my profile |
| POST | `/quiz/save` | Yes | Save quiz progress |
| POST | `/quiz/submit` | Yes | Submit final answers |
| GET | `/quiz/progress` | Yes | Resume saved progress |
| GET | `/matches/feed` | Yes | Get scored match list |
| POST | `/matches/connect` | Yes | Send connect request |
| POST | `/matches/respond` | Yes | Accept/decline request |
| GET | `/messages/conversations` | Yes | Get all conversations |
| GET | `/messages/:id` | Yes | Get message thread |
| POST | `/messages/:id` | Yes | Send a message |
| GET | `/health` | No | Health check |

WebSocket events: `join_conversation`, `send_message`, `typing` → `new_message`, `user_typing`
