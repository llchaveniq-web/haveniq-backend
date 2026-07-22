const { test } = require('node:test');
const assert = require('node:assert');
const { encryptSecret, decryptSecret, isEncrypted } = require('./totpCrypto');

const SECRET = 'JBSWY3DPEHPK3PXP'; // sample base32 TOTP secret

function withKey(key, fn) {
  const prev = process.env.TOTP_ENC_KEY;
  if (key === null) delete process.env.TOTP_ENC_KEY;
  else process.env.TOTP_ENC_KEY = key;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.TOTP_ENC_KEY;
    else process.env.TOTP_ENC_KEY = prev;
  }
}

test('no key configured: encrypt is inert, reads pass through (deploy-safe)', () => {
  withKey(null, () => {
    assert.equal(encryptSecret(SECRET), SECRET, 'stores plaintext when no key');
    assert.equal(isEncrypted(encryptSecret(SECRET)), false);
    assert.equal(decryptSecret(SECRET), SECRET, 'legacy plaintext read passes through');
  });
});

test('with key: round-trips and stored form is encrypted', () => {
  withKey('a-strong-32+char-key-for-testing-000', () => {
    const enc = encryptSecret(SECRET);
    assert.ok(isEncrypted(enc), 'has enc:v1: prefix');
    assert.notEqual(enc, SECRET);
    assert.equal(decryptSecret(enc), SECRET, 'decrypts back to the exact secret');
  });
});

test('backward compatible: legacy plaintext still readable when key is set', () => {
  withKey('a-strong-32+char-key-for-testing-000', () => {
    assert.equal(decryptSecret(SECRET), SECRET, 'plaintext (no prefix) returned as-is');
  });
});

test('non-deterministic IV: two encryptions differ but both decrypt', () => {
  withKey('a-strong-32+char-key-for-testing-000', () => {
    const a = encryptSecret(SECRET), b = encryptSecret(SECRET);
    assert.notEqual(a, b, 'random IV → different ciphertexts');
    assert.equal(decryptSecret(a), SECRET);
    assert.equal(decryptSecret(b), SECRET);
  });
});

test('fails closed: encrypted value read with wrong/missing key → null', () => {
  let enc;
  withKey('key-number-one-aaaaaaaaaaaaaaaaaaaa', () => { enc = encryptSecret(SECRET); });
  withKey('key-number-two-bbbbbbbbbbbbbbbbbbbb', () => {
    assert.equal(decryptSecret(enc), null, 'wrong key → null, not garbage');
  });
  withKey(null, () => {
    assert.equal(decryptSecret(enc), null, 'encrypted value but no key → null');
  });
});

test('fails closed: tampered ciphertext → null (GCM auth)', () => {
  withKey('a-strong-32+char-key-for-testing-000', () => {
    const enc = encryptSecret(SECRET);
    const tampered = enc.slice(0, -2) + (enc.endsWith('A') ? 'B' : 'A');
    assert.equal(decryptSecret(tampered), null);
  });
});

test('null/empty pass through unchanged (disabled account)', () => {
  withKey('a-strong-32+char-key-for-testing-000', () => {
    assert.equal(encryptSecret(null), null);
    assert.equal(encryptSecret(''), '');
    assert.equal(decryptSecret(null), null);
  });
});

test('never double-wraps an already-encrypted value', () => {
  withKey('a-strong-32+char-key-for-testing-000', () => {
    const enc = encryptSecret(SECRET);
    assert.equal(encryptSecret(enc), enc, 're-encrypting an enc:v1: value is a no-op');
  });
});
