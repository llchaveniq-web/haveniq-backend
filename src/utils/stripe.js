/**
 * Stripe initialization — optional, off by default.
 *
 * To enable in production:
 *   1. Create a Stripe account at https://stripe.com
 *   2. Stripe dashboard → Developers → API keys → copy the secret key
 *   3. Stripe → Products → create "HavenIQ+" recurring product ($9.99/mo)
 *      Copy the price ID (price_xxx).
 *   4. Add to Railway env vars:
 *        STRIPE_SECRET_KEY=sk_live_xxx       (test mode: sk_test_xxx)
 *        STRIPE_PRICE_ID=price_xxx
 *        STRIPE_WEBHOOK_SECRET=whsec_xxx     (after step 5)
 *   5. Stripe → Webhooks → add endpoint pointing at
 *        https://haveniq-backend-production.up.railway.app/premium/webhook
 *      Subscribe to customer.subscription.{created,updated,deleted} events.
 *      Copy the signing secret into STRIPE_WEBHOOK_SECRET.
 *   6. Add to package.json: "stripe": "^17.0.0" then `npm install`.
 *
 * Until both the key is set AND the package is installed, this file is
 * a pure no-op — premium routes return 503 with a "coming soon" message.
 */

let stripe = null;
let initialized = false;

function tryInit() {
  if (initialized) return stripe;
  initialized = true;

  if (!process.env.STRIPE_SECRET_KEY) {
    return null;
  }

  try {
    const Stripe = require('stripe');
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-04-30.basil' });
    console.log('[stripe] initialized for', process.env.NODE_ENV || 'development');
    return stripe;
  } catch (err) {
    console.warn('[stripe] init failed — package not installed?', err?.message);
    return null;
  }
}

function isReady() {
  return tryInit() !== null;
}

module.exports = { tryInit, isReady };
