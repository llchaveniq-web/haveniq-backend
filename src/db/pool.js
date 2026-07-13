const { Pool } = require('pg');

// Pool size is env-tunable (PG_POOL_MAX) so capacity can be raised for a launch
// spike WITHOUT a code change/redeploy. Default 20 (was hardcoded 20). Keep this
// × (number of connecting processes/replicas) safely under the database's
// max_connections — leave headroom for migrations, psql sessions, and the
// reserved superuser slots. e.g. one instance at 20 is fine on a 100-connection
// Postgres; if you scale to N replicas, N×PG_POOL_MAX must stay under the limit.
const PG_POOL_MAX = Number.parseInt(process.env.PG_POOL_MAX, 10) || 20;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: PG_POOL_MAX,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error', err);
});

module.exports = pool;
