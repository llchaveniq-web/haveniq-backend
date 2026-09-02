const router = require('express').Router();
const express = require('express');
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const stripeUtil = require('../utils/stripe');
const { quotaFor } = require('../lib/connectQuota');

// ── Plan / cadence → Stripe Price mapping (server-side only) ─────────────────
// The client sends only { plan, billing }. We NEVER trust a price from the
// client — we map plan+cadence to a Price id created in the Stripe dashboard.
// Price AMOUNTS live in Stripe:
//   plus   + monthly  → $6.99/mo   (STRIPE_PRICE_PLUS_MONTHLY)
//   plus   + annual   → $49.99/yr  (STRIPE_PRICE_PLUS_ANNUAL)
//   parent + monthly  → $4.99/mo   (STRIPE_PRICE_PARENT_MONTHLY)
//   parent + annual   → NOT OFFERED (no env entry; rejected in checkout)
const PRICE_ENV = {
  'plus:monthly':   'STRIPE_PRICE_PLUS_MONTHLY',
  'plus:annual':    'STRIPE_PRICE_PLUS_ANNUAL',
  'parent:monthly': 'STRIPE_PRICE_PARENT_MONTHLY',
};
const PLANS = ['plus', 'parent'];
const BILLINGS = ['monthly', 'annual'];
const PREMIUM_STATUSES = ['active', 'trialing']; // what counts as "has access"

/** The configured Stripe Price id for a plan+cadence, or null if unmapped/unset. */
function priceIdFor(plan, billing) {
  const envName = PRICE_ENV[`${plan}:${billing}`];
  const id = envName ? process.env[envName] : null;
  return id || null;
}

/** Reverse map: a configured Price id → its logical plan ('plus'|'parent'). Lets
 *  the webhook label a subscription by plan independent of metadata. */
function planFromPriceId(priceId) {
  if (!priceId) return null;
  for (const [key, envName] of Object.entries(PRICE_ENV)) {
    if (process.env[envName] && process.env[envName] === priceId) return key.split(':')[0];
  }
  return null;
}

/** Period-end unix ts. Stripe moved period fields onto subscription ITEMS in
 *  recent API versions (basil); read the item first, fall back to the legacy
 *  top-level field so we work across versions. */
function periodEndUnix(sub) {
  const v = sub && (sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end);
  return Number.isFinite(v) ? v : null;
}

/** Upsert the subscription row + sync the user's is_premium flag (the rest of the
 *  app gates on users.is_premium). Idempotent; safe for out-of-order webhooks. */
async function applySubscriptionState({ userId, customerId, subscriptionId, status, plan, periodEnd }) {
  await pool.query(
    `INSERT INTO subscriptions
       (user_id, stripe_customer_id, stripe_subscription_id, status, plan, current_period_end, updated_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::bigint IS NULL THEN NULL ELSE to_timestamp($6) END, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET stripe_customer_id     = COALESCE(EXCLUDED.stripe_customer_id, subscriptions.stripe_customer_id),
           stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, subscriptions.stripe_subscription_id),
           status                 = EXCLUDED.status,
           plan                   = COALESCE(EXCLUDED.plan, subscriptions.plan),
           current_period_end     = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
           updated_at             = NOW()`,
    [userId, customerId, subscriptionId, status, plan, periodEnd],
  );
  await pool.query(
    'UPDATE users SET is_premium = $1 WHERE id = $2',
    [PREMIUM_STATUSES.includes(status), userId],
  );
}

function clientBase() {
  return (process.env.CLIENT_URL || '').split(',')[0].trim() || 'https://app.haveniq.org';
}

// ── POST /premium/checkout-session ───────────────────────────────────────────
router.post('/checkout-session', requireAuth, async (req, res) => {
  const { plan, billing } = req.body || {};
  if (!PLANS.includes(plan) || !BILLINGS.includes(billing)) {
    return res.status(400).json({ error: 'Invalid plan or billing cadence.' });
  }
  // parent has no annual price (not offered in the UI). Reject rather than
  // silently bill a different cadence than the user asked for.
  if (plan === 'parent' && billing === 'annual') {
    return res.status(400).json({ error: 'Annual billing is not available for the parent plan.' });
  }

  const stripe = stripeUtil.tryInit();
  const priceId = priceIdFor(plan, billing);
  // Honest 503 when payments aren't wired (missing keys or unmapped price) — the
  // app shows "checkout isn't available yet"; never a fake/empty url.
  if (!stripe || !priceId) {
    return res.status(503).json({ error: 'Premium checkout is not available yet.' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT email, stripe_customer_id FROM users WHERE id = $1', [req.user.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });

    let customerId = rows[0].stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: rows[0].email || undefined,
        metadata: { haveniq_user_id: req.user.id },
      });
      customerId = customer.id;
      await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, req.user.id]);
    }

    const base = clientBase();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // Founding-cohort grants run through Stripe rather than around it: a
      // percent-off promotion code is redeemed here, and Stripe -- not a
      // reminder in someone's calendar -- ends it on schedule. When it lapses,
      // the renewal fails and the subscription webhook flips is_premium back,
      // so the grant expires the same way any other subscription does.
      // Bound each code with max_redemptions when you create it; students
      // share codes, and an unbounded 100%-off code is a free tier by accident.
      allow_promotion_codes: true,
      // A 100%-off cohort owes $0 today, so don't demand a card to start.
      // Paying students are unaffected -- Stripe still collects when the
      // amount due is above zero. Without this, "free for the founding 100"
      // still opens with a credit-card form, which is where signups die.
      payment_method_collection: 'if_required',
      client_reference_id: req.user.id,
      metadata: { userId: req.user.id, plan, billing },
      // Stamp the subscription too, so customer.subscription.* webhooks (which
      // carry no client_reference_id) can identify the user + plan directly.
      subscription_data: { metadata: { userId: req.user.id, plan, billing } },
      success_url: `${base}/premium?status=success`,
      cancel_url:  `${base}/premium?status=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[premium/checkout-session] failed:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ── POST /premium/webhook ────────────────────────────────────────────────────
// The ONLY thing that grants/revokes premium — the client never self-reports.
// Raw body (signature verification) — global JSON parser skips this path (server.js).
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = stripeUtil.tryInit();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) return res.status(503).end(); // Stripe retries; no-op meanwhile.

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (err) {
    console.error('[premium/webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const obj = event.data.object;

    if (event.type === 'checkout.session.completed') {
      // Grant. The session carries client_reference_id (= userId) + our metadata.
      const userId = obj.client_reference_id || obj.metadata?.userId || null;
      const customerId = obj.customer || null;
      let status = 'active';
      let periodEnd = null;
      let plan = obj.metadata?.plan || null;
      const subscriptionId = obj.subscription || null;
      if (subscriptionId) {
        try {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          status = sub.status || 'active';
          periodEnd = periodEndUnix(sub);
          plan = plan || sub.metadata?.plan || planFromPriceId(sub.items?.data?.[0]?.price?.id);
        } catch (e) {
          console.error('[premium/webhook] subscription retrieve failed:', e.message);
        }
      }
      if (userId) await applySubscriptionState({ userId, customerId, subscriptionId, status, plan, periodEnd });
      else console.error('[premium/webhook] checkout.session.completed with no userId');

    } else if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      // Keep status + period in sync; deleted → revoke (back to free).
      const sub = obj;
      const customerId = sub.customer || null;
      const status = event.type === 'customer.subscription.deleted' ? 'canceled' : (sub.status || 'canceled');
      const plan = sub.metadata?.plan || planFromPriceId(sub.items?.data?.[0]?.price?.id) || null;
      const periodEnd = periodEndUnix(sub);

      // Identify the user: subscription metadata first, else by customer id.
      let userId = sub.metadata?.userId || null;
      if (!userId && customerId) {
        const { rows } = await pool.query('SELECT id FROM users WHERE stripe_customer_id = $1', [customerId]);
        userId = rows[0]?.id || null;
      }
      if (userId) await applySubscriptionState({ userId, customerId, subscriptionId: sub.id, status, plan, periodEnd });
      else console.error('[premium/webhook] subscription event for unknown customer', customerId);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[premium/webhook] handler failed:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ── GET /premium/status ──────────────────────────────────────────────────────
// Driven off the LIVE subscription row — a canceled sub loses access.
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT status, plan, current_period_end FROM subscriptions WHERE user_id = $1',
      [req.user.id],
    );
    if (!rows[0]) {
      // No subscription row — free tier. The quota still has to come back, or
      // the app has nothing to render "2 of 5 left today" from and falls back
      // to its own device-local count, which is the thing this replaced.
      return res.json({
        isPremium: false, plan: null, status: null, currentPeriodEnd: null,
        connects: await quotaFor(req.user.id, false),
      });
    }
    const r = rows[0];
    const isPremium = PREMIUM_STATUSES.includes(r.status);
    res.json({
      isPremium,
      // Derived from the SAME isPremium the response reports, so the badge and
      // the allowance can never disagree — a student shown "HavenIQ+" while
      // still being counted would be the worst version of this bug.
      connects:         await quotaFor(req.user.id, isPremium),
      plan:             r.plan ?? null,
      status:           r.status ?? null,
      currentPeriodEnd: r.current_period_end ? new Date(r.current_period_end).toISOString() : null,
    });
  } catch (err) {
    console.error('[premium/status] failed:', err);
    res.status(500).json({ error: 'Failed to load subscription status' });
  }
});

// ── POST /premium/cancel ─────────────────────────────────────────────────────
// Cancel at period end; the webhook flips status when Stripe finalizes it.
router.post('/cancel', requireAuth, async (req, res) => {
  const stripe = stripeUtil.tryInit();
  if (!stripe) return res.status(503).json({ error: 'Premium is not available yet.' });
  try {
    const { rows } = await pool.query(
      'SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1', [req.user.id],
    );
    const subId = rows[0]?.stripe_subscription_id;
    if (!subId) return res.status(404).json({ error: 'No active subscription' });

    await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
    res.json({ success: true });
  } catch (err) {
    console.error('[premium/cancel] failed:', err);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

module.exports = router;
// Exposed for unit tests (router is a function; attaching props is harmless).
module.exports._helpers = { priceIdFor, planFromPriceId, periodEndUnix, PRICE_ENV, PLANS, BILLINGS };
