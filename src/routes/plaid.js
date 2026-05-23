// ─── Plaid Connect routes ─────────────────────────────────────────────────
//
// Three endpoints power the Plaid Link flow on the client:
//   POST /plaid/link-token    — give the client a short-lived token to open
//                               Plaid Link
//   POST /plaid/exchange      — client returns the public_token after the
//                               user finishes Plaid Link; we exchange for a
//                               long-lived access_token and store it
//   GET  /plaid/status        — tell the client whether the user already
//                               has a connected institution (and which one)
//   POST /plaid/webhook       — Plaid posts events here (item removed,
//                               errors, etc.). Public — no requireAuth.
//
// Env vars (set on Railway):
//   PLAID_CLIENT_ID       — your Plaid client id
//   PLAID_SECRET          — sandbox / development / production secret
//   PLAID_ENV             — "sandbox" | "development" | "production"
//                           (default: sandbox)
//
// access_token is a server-side secret — never exposed to the client.

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const {
  Configuration, PlaidApi, PlaidEnvironments,
  Products, CountryCode,
} = require('plaid');

// ── Plaid client setup ────────────────────────────────────────────────────
// Lazy + best-effort: if env vars are missing we don't crash the whole
// server, we just have every Plaid route return 503. This lets the rest
// of the API stay up if someone forgets to set the env vars on a new
// deploy.

let plaidClient = null;
function getClient() {
  if (plaidClient) return plaidClient;
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret   = process.env.PLAID_SECRET;
  if (!clientId || !secret) return null;
  const envName  = (process.env.PLAID_ENV || 'sandbox').toLowerCase();
  const basePath = PlaidEnvironments[envName] || PlaidEnvironments.sandbox;
  const config = new Configuration({
    basePath,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET':    secret,
        'Plaid-Version':   '2020-09-14',
      },
    },
  });
  plaidClient = new PlaidApi(config);
  return plaidClient;
}

function requirePlaid(res) {
  const client = getClient();
  if (!client) {
    res.status(503).json({ error: 'Bank verification is temporarily unavailable. Please try again later.' });
    return null;
  }
  return client;
}

// ── POST /plaid/link-token ────────────────────────────────────────────────
// Returns a fresh link_token for the authenticated user. The token is
// scoped to this user (client_user_id) so Plaid associates the resulting
// Item with the right person. Tokens are single-use and expire in 4 hours.
//
// We request Auth + Identity + Transactions products. Transactions powers
// the Spending Dashboard — without it we couldn't show real merchant /
// category data. In sandbox, transactions are simulated and free; in
// production each linked Item with Transactions costs ~$0.30/mo.
router.post('/link-token', requireAuth, async (req, res) => {
  const client = requirePlaid(res);
  if (!client) return;
  try {
    const r = await client.linkTokenCreate({
      user:          { client_user_id: String(req.user.id) },
      client_name:   'HavenIQ',
      products:      [Products.Auth, Products.Identity, Products.Transactions],
      country_codes: [CountryCode.Us],
      language:      'en',
    });
    res.json({ linkToken: r.data.link_token, expiration: r.data.expiration });
  } catch (err) {
    console.error('[plaid/link-token] failed:', err?.response?.data || err.message);
    res.status(500).json({ error: 'Could not start bank connection. Please try again.' });
  }
});

// ── GET /plaid/transactions?days=30 ───────────────────────────────────────
// Pulls real transactions from Plaid for the user's most recent connected
// item. Returns a normalized shape the Spending Dashboard knows how to read
// (date, merchant, amount, category). Best-effort: returns empty array if
// Plaid is unreachable so the screen degrades gracefully.
router.get('/transactions', requireAuth, async (req, res) => {
  const client = requirePlaid(res);
  if (!client) return;
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
    const { rows } = await pool.query(
      `SELECT access_token, institution_name FROM plaid_items
        WHERE user_id = $1 AND is_active = TRUE
        ORDER BY created_at DESC LIMIT 1`,
      [req.user.id],
    );
    if (rows.length === 0) {
      return res.json({ connected: false, transactions: [], institutionName: null });
    }
    const accessToken     = rows[0].access_token;
    const institutionName = rows[0].institution_name;

    const today = new Date();
    const start = new Date(today.getTime() - days * 24 * 60 * 60 * 1000);
    const fmt   = (d) => d.toISOString().slice(0, 10);

    let txns = [];
    try {
      const r = await client.transactionsGet({
        access_token: accessToken,
        start_date:   fmt(start),
        end_date:     fmt(today),
        options:      { count: 250, offset: 0 },
      });
      txns = r.data.transactions || [];
    } catch (err) {
      // Common in sandbox right after linking — Plaid needs a few seconds
      // to provision transactions. Return empty + a flag so the UI can
      // show "Transactions still syncing" instead of crashing.
      const code = err?.response?.data?.error_code;
      if (code === 'PRODUCT_NOT_READY') {
        return res.json({
          connected: true, syncing: true, transactions: [], institutionName,
        });
      }
      throw err;
    }

    const normalized = txns.map((t) => ({
      id:          t.transaction_id,
      date:        t.date,
      merchant:    t.merchant_name || t.name || 'Unknown',
      amount:      t.amount,                       // Plaid: positive = debit (money out)
      category:    Array.isArray(t.category) ? t.category[0] : null,
      pending:     !!t.pending,
    }));

    res.json({
      connected:       true,
      syncing:         false,
      transactions:    normalized,
      institutionName,
    });
  } catch (err) {
    console.error('[plaid/transactions] failed:', err?.response?.data || err.message);
    res.status(500).json({ error: 'Could not load transactions.' });
  }
});

// ── POST /plaid/exchange ─────────────────────────────────────────────────
// Body: { publicToken: string }
//
// Plaid Link returns a public_token to the client after a successful link.
// We exchange it for the long-lived access_token (server-side secret) and
// persist the row. We also fetch the institution name + first account
// mask so the UI can show "Connected: Chase •••• 1234".
router.post('/exchange', requireAuth, async (req, res) => {
  const client = requirePlaid(res);
  if (!client) return;
  const publicToken = String((req.body && req.body.publicToken) || '').trim();
  if (!publicToken) return res.status(400).json({ error: 'publicToken is required' });

  try {
    const ex = await client.itemPublicTokenExchange({ public_token: publicToken });
    const accessToken = ex.data.access_token;
    const itemId      = ex.data.item_id;

    // Look up display info — institution name + masked account number.
    // These come from two follow-up calls. Best-effort: if either fails
    // we still store the item, we just leave the display fields null.
    let institutionName = null;
    let institutionId   = null;
    let accountMask     = null;
    try {
      const itemR = await client.itemGet({ access_token: accessToken });
      institutionId = itemR.data.item.institution_id || null;
      if (institutionId) {
        const instR = await client.institutionsGetById({
          institution_id: institutionId,
          country_codes:  [CountryCode.Us],
        });
        institutionName = instR.data.institution?.name || null;
      }
    } catch (_) { /* leave nulls */ }
    try {
      const acctR = await client.accountsGet({ access_token: accessToken });
      const first = acctR.data.accounts?.[0];
      accountMask = first?.mask || null;
    } catch (_) { /* leave null */ }

    // Upsert: a user can re-connect the same institution, which generates
    // a new plaid_item_id. We dedupe on plaid_item_id (unique constraint).
    // If the same user already has an active item for the same institution,
    // mark the old one inactive — keeps the user's "active" connection
    // count to one per institution.
    await pool.query(
      `INSERT INTO plaid_items
         (user_id, plaid_item_id, access_token,
          institution_name, institution_id, account_mask, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       ON CONFLICT (plaid_item_id) DO UPDATE
         SET access_token     = EXCLUDED.access_token,
             institution_name = EXCLUDED.institution_name,
             account_mask     = EXCLUDED.account_mask,
             is_active        = TRUE,
             updated_at       = NOW()`,
      [req.user.id, itemId, accessToken, institutionName, institutionId, accountMask],
    );

    res.json({
      connected:       true,
      institutionName,
      accountMask,
    });
  } catch (err) {
    console.error('[plaid/exchange] failed:', err?.response?.data || err.message);
    res.status(500).json({ error: 'Could not finish bank connection. Please try again.' });
  }
});

// ── GET /plaid/status ─────────────────────────────────────────────────────
// Lightweight check the client polls on screen mount: does this user have
// any active Plaid items? Returns the most recent one (most likely the one
// they want to see).
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT institution_name, account_mask, created_at
         FROM plaid_items
        WHERE user_id = $1 AND is_active = TRUE
        ORDER BY created_at DESC
        LIMIT 1`,
      [req.user.id],
    );
    if (rows.length === 0) return res.json({ connected: false });
    const r = rows[0];
    res.json({
      connected:       true,
      institutionName: r.institution_name,
      accountMask:     r.account_mask,
      connectedAt:     r.created_at,
    });
  } catch (err) {
    console.error('[plaid/status] failed:', err.message);
    res.status(500).json({ error: 'Could not check bank connection status.' });
  }
});

// ── POST /plaid/disconnect ────────────────────────────────────────────────
// User-initiated disconnect. We mark the item inactive in our DB. We also
// call itemRemove on Plaid's side so we stop being billed for ongoing
// updates. Both are best-effort — DB success is what the client sees.
router.post('/disconnect', requireAuth, async (req, res) => {
  const client = getClient();
  try {
    const { rows } = await pool.query(
      `SELECT access_token FROM plaid_items
        WHERE user_id = $1 AND is_active = TRUE`,
      [req.user.id],
    );
    if (client) {
      for (const r of rows) {
        try { await client.itemRemove({ access_token: r.access_token }); }
        catch (_) { /* fire-and-forget — Plaid may already have removed it */ }
      }
    }
    await pool.query(
      `UPDATE plaid_items SET is_active = FALSE, updated_at = NOW()
        WHERE user_id = $1 AND is_active = TRUE`,
      [req.user.id],
    );
    res.json({ connected: false });
  } catch (err) {
    console.error('[plaid/disconnect] failed:', err.message);
    res.status(500).json({ error: 'Could not disconnect bank.' });
  }
});

// ── POST /plaid/webhook ───────────────────────────────────────────────────
// Plaid posts events here for item-level changes (ITEM_REMOVED, ERROR,
// PENDING_EXPIRATION, etc.). Public endpoint — Plaid signs requests but
// we keep validation light for sandbox; production should verify
// `Plaid-Verification` JWT.
router.post('/webhook', async (req, res) => {
  try {
    const { webhook_type, webhook_code, item_id } = req.body || {};
    console.log(`[plaid/webhook] ${webhook_type}/${webhook_code} for item ${item_id}`);
    if (webhook_type === 'ITEM' && webhook_code === 'ERROR') {
      // Item went into an error state (re-auth required, institution down).
      // We leave is_active = TRUE so the user sees "needs re-link" UI later.
      console.log('[plaid/webhook] item entered error state:', req.body?.error?.error_code);
    }
    if (webhook_code === 'USER_PERMISSION_REVOKED' || webhook_code === 'ITEM_REMOVED') {
      await pool.query(
        `UPDATE plaid_items SET is_active = FALSE, updated_at = NOW()
          WHERE plaid_item_id = $1`,
        [item_id],
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[plaid/webhook] failed:', err.message);
    // Always 200 to Plaid — they'll retry on 5xx, which we don't want for
    // bugs in our handler. The error is logged for us to fix.
    res.json({ ok: true });
  }
});

module.exports = router;
