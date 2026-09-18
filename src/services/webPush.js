// ═══════════════════════════════════════════════════════════════════════════
//  Web push: reaching a student in their browser, without their inbox.
//
//  Every student so far came in through app.haveniq.org, and until this file
//  the web app had no push at all. sendPushToUser only spoke Expo, which only
//  reaches the native app. So every alert a web student could get was an
//  email, and .edu mail at Microsoft schools lands in Junk: the first real
//  signup from LBCC was lost exactly there.
//
//  This sends the same notifications sendPushToUser already sends, to every
//  browser the student turned alerts on in. It is called FROM sendPushToUser,
//  so the existing callers (messages, connect requests, vouches, housing
//  alerts, review status) reach the web without any of them changing.
//
//  Keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY. Without them this is
//  an honest no-op: nothing is sent and the public key route says so, so the
//  app never asks a student for a permission it cannot use.
// ═══════════════════════════════════════════════════════════════════════════

const webpush = require('web-push');

let configured = null;

function configure() {
  if (configured !== null) return configured;
  const pub  = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) { configured = false; return false; }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:support@haveniq.org', pub, priv);
  configured = true;
  return true;
}

function publicKey() {
  return configure() ? process.env.VAPID_PUBLIC_KEY : null;
}

// Where a tap should land. Mirrors the native tap router in the app's
// _layout.tsx (the addNotificationResponseReceivedListener block), so a web
// notification opens the same screen the phone app would. Only ever a path on
// our own origin: the service worker opens whatever this returns.
function urlFor(data) {
  const d = data || {};
  const id = (v) => encodeURIComponent(String(v));
  switch (d.screen) {
    case 'thread':          return d.conversationId ? `/thread/${id(d.conversationId)}` : '/messages';
    case 'messages':        return '/messages';
    case 'matches':         return '/matches';
    case 'checkin':         return d.id ? `/checkin/${id(d.id)}` : '/home';
    case 'verify-edu':      return '/verify-edu';
    case 'circle':          return '/circle';
    case 'housing-browser': return d.listingId ? `/listing/${id(d.listingId)}` : '/housing';
    default:                return '/home';
  }
}

// A subscription that fails this many times in a row without the push
// service saying "gone" is treated as gone anyway.
const MAX_FAILURES = 5;

async function sendWebPushToUser(pool, userId, { title, body, data } = {}, deps = {}) {
  const wp = deps.webpush || webpush;
  if (!deps.webpush && !configure()) return { sent: 0, skipped: 'unconfigured' };

  const { rows } = await pool.query(
    'SELECT id, endpoint, p256dh, auth FROM web_push_subscriptions WHERE user_id = $1',
    [userId],
  );
  if (!rows.length) return { sent: 0 };

  const payload = JSON.stringify({
    title: title || 'HavenIQ',
    body:  body || '',
    url:   urlFor(data),
    // Same kind of alert replaces the last one instead of stacking: five
    // messages in one thread are one notification that updates.
    tag:   data && data.screen === 'thread' && data.conversationId
             ? `thread-${data.conversationId}`
             : (data && data.screen) || 'haveniq',
  });

  let sent = 0;
  for (const s of rows) {
    try {
      await wp.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 60 * 60 * 24, urgency: 'high' },
      );
      sent++;
      await pool.query(
        'UPDATE web_push_subscriptions SET last_success_at = NOW(), failures = 0 WHERE id = $1',
        [s.id],
      ).catch(() => {});
    } catch (err) {
      const code = err && err.statusCode;
      // 404 and 410 are the push service saying this subscription no longer
      // exists: the student cleared site data, revoked permission, or the
      // browser rotated it. Keeping it would mean failing on it forever.
      if (code === 404 || code === 410) {
        await pool.query('DELETE FROM web_push_subscriptions WHERE id = $1', [s.id]).catch(() => {});
      } else {
        await pool.query(
          `UPDATE web_push_subscriptions SET failures = failures + 1 WHERE id = $1`,
          [s.id],
        ).catch(() => {});
        await pool.query(
          'DELETE FROM web_push_subscriptions WHERE id = $1 AND failures >= $2',
          [s.id, MAX_FAILURES],
        ).catch(() => {});
        console.error('[webPush] send failed', code || '', (err && err.message) || err);
      }
    }
  }
  return { sent };
}

// The push services browsers actually hand out: Chrome and most Android
// browsers (Google), Firefox (Mozilla), Safari on iPhone and Mac (Apple), Edge
// (Microsoft). An endpoint is a URL this server will POST to, so accepting any
// https host would let a client point our server at an address of its
// choosing. Only these hosts, and subdomains of them, are subscriptions.
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  'notify.windows.com',
];

function isPushHost(hostname) {
  const h = String(hostname).toLowerCase();
  return PUSH_HOSTS.some(p => h === p || h.endsWith('.' + p));
}

// Only accept what a real browser PushSubscription looks like.
function validSubscription(sub) {
  if (!sub || typeof sub !== 'object') return false;
  const { endpoint, keys } = sub;
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return false;
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (!isPushHost(u.hostname)) return false;
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return false;
  if (keys.p256dh.length > 256 || keys.auth.length > 64) return false;
  return true;
}

function _resetForTests() { configured = null; }

module.exports = { sendWebPushToUser, publicKey, urlFor, validSubscription, _resetForTests };
