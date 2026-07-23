// The staging bypass gate. Everything behind it is an authentication bypass,
// so the property that matters is: NOTHING opens on production, no matter how
// the flags are set. node --test.
const test = require('node:test');
const assert = require('node:assert');
const { isProdEnvironment, stagingFlag, stagingOtp } = require('./stagingGuard');

const withEnv = (vars, fn) => {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
};

// ── The one that matters ──
test('PRODUCTION: no flag can open a bypass', () => {
  withEnv({
    RAILWAY_ENVIRONMENT: 'production',
    ALLOW_DEMO_SESSION: 'true',
    ALLOW_ANY_EMAIL_DOMAIN: 'true',
    STAGING_LOGIN_OTP: '123456',
  }, () => {
    assert.equal(stagingFlag('ALLOW_DEMO_SESSION'), false, 'demo session must stay closed on prod');
    assert.equal(stagingFlag('ALLOW_ANY_EMAIL_DOMAIN'), false, '.edu relax must stay closed on prod');
    assert.equal(stagingOtp(), null, 'no master OTP on prod');
  });
});

test('production is detected from RAILWAY_ENVIRONMENT, not NODE_ENV', () => {
  // Verified against Railway 2026-07-22: BOTH environments run
  // NODE_ENV=production, so NODE_ENV cannot distinguish them.
  withEnv({ RAILWAY_ENVIRONMENT: 'staging', NODE_ENV: 'production' }, () => {
    assert.equal(isProdEnvironment(), false, 'staging must not read as prod just because NODE_ENV says production');
  });
  withEnv({ RAILWAY_ENVIRONMENT: 'production', NODE_ENV: 'staging' }, () => {
    assert.equal(isProdEnvironment(), true, 'prod must read as prod even if NODE_ENV is wrong');
  });
});

test('prod detection is case/whitespace tolerant', () => {
  for (const v of ['Production', 'PRODUCTION', ' production ']) {
    withEnv({ RAILWAY_ENVIRONMENT: v, ALLOW_DEMO_SESSION: 'true' }, () => {
      assert.equal(stagingFlag('ALLOW_DEMO_SESSION'), false, `"${v}" must be treated as production`);
    });
  }
});

// ── Staging behaviour ──
test('STAGING: a bypass needs its explicit flag; absent means closed', () => {
  withEnv({ RAILWAY_ENVIRONMENT: 'staging', ALLOW_DEMO_SESSION: undefined }, () => {
    assert.equal(stagingFlag('ALLOW_DEMO_SESSION'), false, 'unset ⇒ closed');
  });
  withEnv({ RAILWAY_ENVIRONMENT: 'staging', ALLOW_DEMO_SESSION: 'true' }, () => {
    assert.equal(stagingFlag('ALLOW_DEMO_SESSION'), true);
  });
});

test('only the exact string "true" opens a flag', () => {
  for (const v of ['1', 'yes', 'TRUE ', 'false', '']) {
    withEnv({ RAILWAY_ENVIRONMENT: 'staging', ALLOW_DEMO_SESSION: v }, () => {
      const expected = v.trim().toLowerCase() === 'true';
      assert.equal(stagingFlag('ALLOW_DEMO_SESSION'), expected, `"${v}"`);
    });
  }
});

test('flags are independent — one does not enable another', () => {
  withEnv({ RAILWAY_ENVIRONMENT: 'staging', ALLOW_DEMO_SESSION: 'true', ALLOW_ANY_EMAIL_DOMAIN: undefined }, () => {
    assert.equal(stagingFlag('ALLOW_DEMO_SESSION'), true);
    assert.equal(stagingFlag('ALLOW_ANY_EMAIL_DOMAIN'), false);
  });
});

// ── The fixed OTP ──
test('the staging OTP must be exactly 6 digits, else it is refused', () => {
  const cases = { '123456': '123456', '12345': null, '1234567': null, 'abcdef': null, '': null, '  ': null };
  for (const [set, expect] of Object.entries(cases)) {
    withEnv({ RAILWAY_ENVIRONMENT: 'staging', STAGING_LOGIN_OTP: set }, () => {
      assert.equal(stagingOtp(), expect, `"${set}" ⇒ ${expect}`);
    });
  }
});

test('an unset staging OTP is null (no accidental blank master code)', () => {
  withEnv({ RAILWAY_ENVIRONMENT: 'staging', STAGING_LOGIN_OTP: undefined }, () => {
    assert.equal(stagingOtp(), null);
  });
});

// ── Outside Railway (local dev) ──
test('with no RAILWAY_ENVIRONMENT, the explicit flag is still required', () => {
  withEnv({ RAILWAY_ENVIRONMENT: undefined, ALLOW_DEMO_SESSION: undefined }, () => {
    assert.equal(stagingFlag('ALLOW_DEMO_SESSION'), false);
  });
  withEnv({ RAILWAY_ENVIRONMENT: undefined, ALLOW_DEMO_SESSION: 'true' }, () => {
    assert.equal(stagingFlag('ALLOW_DEMO_SESSION'), true, 'local dev can opt in explicitly');
  });
});
