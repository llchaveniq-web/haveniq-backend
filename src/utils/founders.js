/**
 * Founder identification — single source of truth.
 *
 * Founders can be identified by user id (FOUNDER_USER_IDS, comma-separated
 * UUIDs) OR by email (FOUNDER_EMAILS, comma-separated). Email is the practical
 * one — the founder knows their login email, not their internal UUID. Used by:
 *   - /admin/*                 — gates the founder-only admin endpoints
 *                                (review queue, parent digest, seed demos)
 *   - /matches/feed            — founders see demo users for investor demos
 *   - /matches/requests        — same
 *   - /quiz/preview-matches    — founders see demo users in the Q10 preview
 *   - /users/me/viewers        — same
 *
 * Defaults cover the founder's known account(s) so prod works even when the
 * env vars aren't set.
 */

const DEFAULT_FOUNDER_IDS = ['d5ade30f-be9f-45a8-bcb4-90be3ee25ecb'];
const DEFAULT_FOUNDER_EMAILS = ['jberney@student.cccd.edu'];

function getFounderIds() {
  const env = (process.env.FOUNDER_USER_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return env.length > 0 ? env : DEFAULT_FOUNDER_IDS;
}

function getFounderEmails() {
  const env = (process.env.FOUNDER_EMAILS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return env.length > 0 ? env : DEFAULT_FOUNDER_EMAILS;
}

function isFounder(userId) {
  if (!userId) return false;
  return getFounderIds().includes(userId);
}

function isFounderEmail(email) {
  if (!email) return false;
  return getFounderEmails().includes(String(email).toLowerCase());
}

/** Preferred check — accepts the req.user row (has id + email). */
function isFounderUser(user) {
  return !!user && (isFounder(user.id) || isFounderEmail(user.email));
}

module.exports = { getFounderIds, getFounderEmails, isFounder, isFounderEmail, isFounderUser };
