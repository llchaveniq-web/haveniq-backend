#!/usr/bin/env node
/**
 * Mint valid bearer tokens for the load test WITHOUT exposing JWT_SECRET.
 *
 * Run it through the Railway CLI so the STAGING backend's env (incl. JWT_SECRET)
 * is injected — the secret never touches your shell history or this repo:
 *
 *   railway link                       # pick the STAGING backend service
 *   railway run node scripts/mint-loadtest-tokens.js <id1> <id2> <id3> <id4> <id5>
 *
 * It prints a `TOKENS=…` line — paste that straight into the k6 step.
 *
 * The claims + algorithm below EXACTLY mirror src/middleware/auth.js signToken
 * ({ userId } only — NO `purpose` claim, which requireAuth would reject — HS256
 * default, JWT_EXPIRES_IN||7d), so these verify against the real API.
 */

const jwt = require('jsonwebtoken');

const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) {
  console.error('JWT_SECRET missing/short in env. Run via `railway run` linked to the STAGING backend service.');
  process.exit(1);
}

const ids = process.argv.slice(2).map(s => s.trim()).filter(Boolean);
if (ids.length === 0) {
  console.error('Usage: railway run node scripts/mint-loadtest-tokens.js <userId> [userId ...]');
  process.exit(1);
}

const tokens = ids.map(id =>
  jwt.sign({ userId: id }, secret, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }),
);

ids.forEach((id, i) => console.error(`# ${id}\n${tokens[i]}\n`)); // stderr = human view
console.log('TOKENS=' + tokens.join(','));                        // stdout = the copy-paste line
