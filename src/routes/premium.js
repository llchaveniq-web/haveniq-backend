const router = require('express').Router();
const express = require('express');
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const stripeUtil = require('../utils/stripe');

// ── GET /premium/status ──────────────────────────────────────────────────
// Returns the caller's current subscription state. Always works regardless
// of whether Stripe is configured — falls back to `{ isPremium: false }`
// when there's no row in subscriptions.
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT status, plan, current_period_end
       FROM subscriptions WHERE user_id = $1`,
      [req.user.id],
    );
    if (!rows[0]) return res.json({ isPremium: false });
    const r = rows[0];
    const isPremium = ['active', 'trialing'].includes(r.status);
    res.json({
      isPremium,
      plan:               r.plan,
      status:             r.status,
      currentPeriodEnd:   r.current_period_end,
    });
  } catch (err) {
    console.error('premium status failed:', err);
    res.status(500).json({ error: 'Failed to load subscription status' });
  }
});

// ── POST /premium/checkout-session ───────────────────────────────────────
// Creates a Stripe Checkout Session and returns the URL the client
// should redirect the user to. Idempotently creates / reuses a Stripe
// customer keyed by the user's email. 503 when Stripe isn't configured.
router.post('/checkout-session', requireAuth, async (req, res) => {
  const stripe = stripeUtil.tryInit();
  if (!stripe) {
    return res.status(503).json({
      error: 'Premium tier is coming soon — payments not yet enabled.',
    });
  }

  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) {
    return res.status(503).json({ error: 'STRIPE_PRICE_ID not configured.' });
  }

  try {
    const { rows: userRows } = await pool.query(
      'SELECT email FROM users WHERE id = $1',
      [req.user.id],
    );
    const email = userRows[0]?.email;
    if (!email) return res.status(404).json({ error: 'User not found' });

    // Reuse the existing Stripe customer if we have one stashed.
    let customerId = null;
    const { rows: subRows } = await pool.query(
      'SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1',
      [req.user.id],
    );
    customerId = subRows[0]?.stripe_customer_id ?? null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { haveniq_user_id: req.user.id },
      });
      customerId = customer.id;
      // Pre-insert with status='pending' so the webhook can find us later.
      await pool.query(
        `INSERT INTO subscriptions (user_id, stripe_customer_id, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = $2`,
        [req.user.id, customerId],
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer:  customerId,
      mode:      'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.CLIENT_URL || 'https://app.haveniq.org'}/premium?success=1`,
      cancel_url:  `${process.env.CLIENT_URL || 'https://app.haveniq.org'}/premium?cancelled=1`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('checkout session failed:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ── POST /premium/cancel ─────────────────────────────────────────────────
// Sets cancel_at_period_end on the user's active subscription. The user
// keeps premium until current_period_end, then Stripe fires a
// subscription.deleted webhook and we flip status to 'canceled'.
router.post('/cancel', requireAuth, async (req, res) => {
  const stripe = stripeUtil.tryInit();
  if (!stripe) return res.status(503).json({ error: 'Premium tier not yet enabled.' });

  try {
    const { rows } = await pool.query(
      'SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1',
      [req.user.id],
    );
    const subId = rows[0]?.stripe_subscription_id;
    if (!subId) return res.status(404).json({ error: 'No active subscription' });

    await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
    res.json({ success: true });
  } catch (err) {
    console.error('cancel subscription failed:', err);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// ── POST /premium/webhook ────────────────────────────────────────────────
// Stripe → us. MUST consume the raw body (not the JSON-parsed one) so
// signature verification works. Mounted with express.raw() instead of
// the global JSON parser (see server.js).
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const stripe = stripeUtil.tryInit();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripe || !secret) {
      return res.status(503).end(); // Stripe will retry; meanwhile, no-op.
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
    } catch (err) {
      console.error('webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (
        event.type === 'customer.subscription.created' ||
        event.type === 'customer.subscription.updated' ||
        event.type === 'customer.subscription.deleted'
      ) {
        const sub = event.data.object;
        await pool.query(
          `UPDATE subscriptions
             SET stripe_subscription_id = $1,
                 status                 = $2,
                 plan                   = $3,
                 current_period_end     = to_timestamp($4),
                 updated_at             = NOW()
           WHERE stripe_customer_id = $5`,
          [
            sub.id,
            sub.status,
            sub.items?.data?.[0]?.price?.id ?? null,
            sub.current_period_end,
            sub.customer,
          ],
        );
      }
      res.json({ received: true });
    } catch (err) {
      console.error('webhook handler failed:', err);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  },
);

module.exports = router;
