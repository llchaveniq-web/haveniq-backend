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

// ── Moderators ──────────────────────────────────────────────────────────────
// A moderator can work the trust-&-safety queue — view reports, change their
// status, ban/unban, see a reported user's detail — but NOT the founder-only
// ops/business surfaces (/ops/*, growth digest, demo seeding, feed demo users).
// Designated by env: MODERATOR_EMAILS (comma-separated, practical) and/or
// MODERATOR_USER_IDS. Founders are ALWAYS moderators, so adding a moderator only
// ever WIDENS who can triage — it never removes founder access. No default
// moderators: until the founder sets the env, they are the only triager.
function getModeratorEmails() {
  return (process.env.MODERATOR_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
function getModeratorIds() {
  return (process.env.MODERATOR_USER_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

/** Preferred check — accepts the req.user row (has id + email). Founder ⊆ moderator. */
function isModeratorUser(user) {
  if (!user) return false;
  if (isFounderUser(user)) return true;   // founders can always moderate
  if (user.id && getModeratorIds().includes(user.id)) return true;
  if (user.email && getModeratorEmails().includes(String(user.email).toLowerCase())) return true;
  return false;
}

// ── Researchers ─────────────────────────────────────────────────────────────
// A researcher can read the longitudinal pair dataset (/research/*) — the ONLY
// surface that may join both sides of a pairing, because cohort analysis needs
// signal→intervention→outcome across both roommates. It grants nothing else: no
// triage, no ops, no product data.
//
// Designated by env: RESEARCH_EMAILS (comma-separated) and/or RESEARCH_USER_IDS.
// Founders are always researchers. Deliberately NO defaults beyond the founder —
// until the env is set, the founder is the only account that can export, so an
// unset variable fails CLOSED rather than opening the dataset.
function getResearchEmails() {
  return (process.env.RESEARCH_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
function getResearchIds() {
  return (process.env.RESEARCH_USER_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

/** Preferred check — accepts the req.user row (has id + email). Founder ⊆ researcher. */
function isResearchUser(user) {
  if (!user) return false;
  if (isFounderUser(user)) return true;
  if (user.id && getResearchIds().includes(user.id)) return true;
  if (user.email && getResearchEmails().includes(String(user.email).toLowerCase())) return true;
  return false;
}

module.exports = {
  getFounderIds, getFounderEmails, isFounder, isFounderEmail, isFounderUser,
  getModeratorEmails, getModeratorIds, isModeratorUser,
  getResearchEmails, getResearchIds, isResearchUser,
};
