// ── Pre-launch access gate ────────────────────────────────────────────────
// CURRENT STATE: OPEN / PUBLIC (2026-06-08) — any verified .edu student can
// join. The lock below is the mechanism to make it private again.
//
// While LOCKED, only allowlisted emails can request an OTP, verify, or use an
// authenticated session — even though the app URL is public. That mode keeps
// HavenIQ private to the founder + invited helpers (used during pre-launch).
//
// Safety:
//   • The founder email is hardcoded into the allowlist, so a missing or
//     mistyped env var can NEVER lock the founder out of his own app.
//   • Default state is LOCKED (fail-safe). The gate opens ONLY when
//     PRELAUNCH_LOCK is explicitly set to the string "false".
//
// Operating it:
//   • Add a helper without a code change → set PRELAUNCH_ALLOWLIST in Railway
//     to a comma-separated list of emails (e.g. "cam@x.edu,quinn@y.edu").
//   • OPEN TO EVERYONE at launch → set PRELAUNCH_LOCK=false in Railway
//     (or remove this gate in code and redeploy).
//
// All comparisons are lowercased + trimmed to match how emails are stored.

const FOUNDER_EMAIL = 'jberney@student.cccd.edu';

// Invited testers / helpers — hardcoded so access can be granted without
// touching Railway env. Add or remove emails here and redeploy. (For a
// no-code-change addition, use the PRELAUNCH_ALLOWLIST env var instead.)
const INVITED = [
  'u1579080@umail.com.utah.edu',  // 2026-06-08 — matching-process tester
];

const envAllow = (process.env.PRELAUNCH_ALLOWLIST || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const ALLOWLIST = new Set([
  FOUNDER_EMAIL,
  ...INVITED.map(e => e.trim().toLowerCase()),
  ...envAllow,
]);

// PUBLIC as of 2026-06-08 — the app is OPEN to any verified .edu student.
// (The .edu / academic-TLD gate in /send-code still applies; this layer is
// just the pre-launch private lock.) To RE-LOCK it to the allowlist, set
// PRELAUNCH_LOCK=true in Railway (or flip this back to `!== 'false'`).
const LOCKED = process.env.PRELAUNCH_LOCK === 'true';

function isAllowed(email) {
  if (!LOCKED) return true;
  return ALLOWLIST.has(String(email || '').trim().toLowerCase());
}

const PRELAUNCH_MESSAGE =
  "HavenIQ is in private pre-launch and isn't open yet. We'll email you the moment it opens at your school.";

module.exports = { isAllowed, isLocked: () => LOCKED, ALLOWLIST, PRELAUNCH_MESSAGE };
