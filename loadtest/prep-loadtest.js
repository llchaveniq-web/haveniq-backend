#!/usr/bin/env node
/**
 * Prep a seeded staging DB for the journey load test:
 *  1. normalize every loadtest user's logistics so connect viability always passes
 *  2. wipe connect_requests (fresh pairs)
 *  3. write loadtest/pairs.json  = [[viewerIndex, targetUserId], ...] (known-valid)
 *     and loadtest/viewer-ids.txt = the ordered viewer ids (feed to mint-tokens)
 *
 * Run AFTER scripts/seed-loadtest.js. Requires DATABASE_URL (staging PUBLIC url).
 *   DATABASE_URL='<staging url>' VIEWER_COUNT=20 node loadtest/prep-loadtest.js
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const VIEWER_COUNT = parseInt(process.env.VIEWER_COUNT, 10) || 20;
const DOMAIN = process.env.SEED_EMAIL_DOMAIN || 'loadtest.ohio.edu';
if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL (staging PUBLIC url).'); process.exit(1); }
let host = '?'; try { host = new URL(process.env.DATABASE_URL).host; } catch {}
console.log('target DB host:', host);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const c = await pool.connect();
  try {
    await c.query('update users set budget_min=800, budget_max=1600, move_in_timeline=$1 where email like $2', ['Flexible', `%@${DOMAIN}`]);
    await c.query('delete from connect_requests');
    const emails = [...Array(VIEWER_COUNT)].map((_, i) => `loadtest-${i}@${DOMAIN}`);
    const vr = await c.query('select id,email from users where email = ANY($1)', [emails]);
    const idByEmail = Object.fromEntries(vr.rows.map(r => [r.email, r.id]));
    const viewerIds = emails.map(e => idByEmail[e]).filter(Boolean);
    const vidx = new Map(viewerIds.map((id, i) => [id, i]));
    const rows = (await c.query('select user_a,user_b from compatibility_scores where score>=40 and is_hard_blocked=false')).rows;
    const pairs = [];
    for (const r of rows) {
      if (vidx.has(r.user_a)) pairs.push([vidx.get(r.user_a), r.user_b]);
      else if (vidx.has(r.user_b)) pairs.push([vidx.get(r.user_b), r.user_a]);
    }
    fs.writeFileSync(path.join(__dirname, 'pairs.json'), JSON.stringify(pairs));
    fs.writeFileSync(path.join(__dirname, 'viewer-ids.txt'), viewerIds.join(' '));
    console.log(`viewers: ${viewerIds.length} | valid connect pairs: ${pairs.length}`);
    console.log('Next: mint tokens →  railway run -e staging -s haveniq-backend node scripts/mint-loadtest-tokens.js $(cat loadtest/viewer-ids.txt)');
  } finally { c.release(); await pool.end(); }
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
