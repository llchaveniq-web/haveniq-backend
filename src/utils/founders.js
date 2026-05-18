/**
 * Founder identification — single source of truth.
 *
 * The FOUNDER_USER_IDS env var (comma-separated UUIDs) controls who's
 * considered a founder. Used by:
 *   - /admin/stats             — gates the dashboard entirely
 *   - /matches/feed            — founders see demo users for investor demos
 *   - /matches/requests        — same
 *   - /users/me/viewers        — same
 *
 * Defaults to Jackson when the env var isn't set so local dev still
 * has someone with founder-level access.
 */

const DEFAULT_FOUNDER_IDS = ['d5ade30f-be9f-45a8-bcb4-90be3ee25ecb'];

function getFounderIds() {
  const env = (process.env.FOUNDER_USER_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return env.length > 0 ? env : DEFAULT_FOUNDER_IDS;
}

function isFounder(userId) {
  if (!userId) return false;
  return getFounderIds().includes(userId);
}

module.exports = { getFounderIds, isFounder };
