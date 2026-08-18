const { test } = require('node:test');
const assert = require('node:assert');
const { encryptToken, decryptToken, isEncrypted } = require('./plaidCrypto');

const TOKEN = 'access-sandbox-11111111-2222-3333-4444-555555555555'; // sample Plaid access_token shape

function withKey(key, fn) {
  const prev = process.env.PLAID_TOKEN_ENC_KEY;
  if (key === null) delete process.env.PLAID_TOKEN_ENC_KEY;
  else process.env.PLAID_TOKEN_ENC_KEY = key;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.PLAID_TOKEN_ENC_KEY;
    else process.env.PLAID_TOKEN_ENC_KEY = prev;
  }
}

test('no key configured: encrypt is inert, reads pass through (deploy-safe)', () => {
  withKey(null, () => {
    assert.equal(encryptToken(TOKEN), TOKEN, 'stores plaintext when no key');
    assert.equal(isEncrypted(encryptToken(TOKEN)), false);
    assert.equal(decryptToken(TOKEN), TOKEN, 'legacy plaintext read passes through');
  });
});

test('with key: round-trips and stored form is encrypted', () => {
  withKey('a-strong-32+char-key-for-testing-000', () => {
    const enc = encryptToken(TOKEN);
    assert.ok(isEncrypted(enc), 'has enc:v1: prefix');
    assert.notEqual(enc, TOKEN);
    assert.equal(decryptToken(enc), TOKEN, 'decrypts back to the exact token');
  });
});

test('backward compatible: legacy plaintext (rows written before this change) still readable when key is set', () => {
  withKey('a-strong-32+char-key-for-testing-000', () => {
    assert.equal(decryptToken(TOKEN), TOKEN, 'plaintext (no prefix) returned as-is');
  });
});

test('non-deterministic IV: two encryptions differ but both decrypt', () => {
  withKey('a-strong-32+char-key-for-testing-000', () => {
    const a = encryptToken(TOKEN), b = encryptToken(TOKEN);
    assert.notEqual(a, b, 'random IV → different ciphertexts');
    assert.equal(decryptToken(a), TOKEN);
    assert.equal(decryptToken(b), TOKEN);
  });
});

test('fails closed: encrypted value read with wrong/missing key → null (never calls Plaid with garbage)', () => {
  let enc;
  withKey('key-number-one-aaaaaaaaaaaaaaaaaaaa', () => { enc = encryptToken(TOKEN); });
  withKey('key-number-two-bbbbbbbbbbbbbbbbbbbb', () => {
    assert.equal(decryptToken(enc), null, 'wrong key → null, not garbage');
  });
  withKey(null, () => {
    assert.equal(decryptToken(enc), null, 'encrypted value but no key → null');
  });
});

test('fails closed: tampered ciphertext → null (GCM auth)', () => {
  withKey('a-strong-32+char-key-for-testing-000', () => {
    const enc = encryptToken(TOKEN);
    const tampered = enc.slice(0, -2) + (enc.endsWith('A') ? 'B' : 'A');
    assert.equal(decryptToken(tampered), null);
  });
});

test('null/empty pass through unchanged', () => {
  withKey('a-strong-32+char-key-for-testing-000', () => {
    assert.equal(encryptToken(null), null);
    assert.equal(encryptToken(''), '');
    assert.equal(decryptToken(null), null);
  });
});

test('never double-wraps an already-encrypted value', () => {
  withKey('a-strong-32+char-key-for-testing-000', () => {
    const enc = encryptToken(TOKEN);
    assert.equal(encryptToken(enc), enc, 're-encrypting an enc:v1: value is a no-op');
  });
});

test('uses a SEPARATE key from TOTP_ENC_KEY — a compromise of one secret type must not expose the other', () => {
  withKey('plaid-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', () => {
    const prevTotp = process.env.TOTP_ENC_KEY;
    process.env.TOTP_ENC_KEY = 'totp-key-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    try {
      const enc = encryptToken(TOKEN);
      // Decrypting with plaidCrypto (reads PLAID_TOKEN_ENC_KEY) must still work
      // regardless of what TOTP_ENC_KEY happens to be set to.
      assert.equal(decryptToken(enc), TOKEN);
    } finally {
      if (prevTotp === undefined) delete process.env.TOTP_ENC_KEY;
      else process.env.TOTP_ENC_KEY = prevTotp;
    }
  });
});
