const crypto = require('crypto');

// Encrypt the Plaid access_token at rest so a DB dump can't pull real bank
// transaction/identity data for every connected student. Stored form is
// `enc:v1:<base64(iv | authTag | ciphertext)>` using AES-256-GCM
// (authenticated — tampering fails the read). Exact same shape as
// lib/totpCrypto.js's TOTP-secret encryption — deliberately NOT sharing its
// key (PLAID_TOKEN_ENC_KEY is separate from TOTP_ENC_KEY): a real bank
// access_token and a 2FA seed are different blast radii, and a compromise
// of one key should never hand over the other secret type too.
//
// Deliberately backward-compatible and deploy-safe, same reasoning as
// totpCrypto.js:
//   • If PLAID_TOKEN_ENC_KEY is NOT set, writes store plaintext and reads
//     pass through unchanged — so this can ship BEFORE the key exists on
//     Railway without breaking bank verification. Encryption activates the
//     moment the key is set.
//   • Reads accept BOTH the encrypted form and legacy plaintext (rows
//     written before this change), so already-connected accounts keep
//     working. A row re-encrypts on its next write (POST /plaid/exchange
//     re-linking, or a future lazy-migration pass) rather than needing a
//     one-time backfill script before this can ship.
const PREFIX = 'enc:v1:';
const IV_LEN = 12;   // GCM standard nonce
const TAG_LEN = 16;

// Derive a 32-byte key from the env value (any sufficiently strong string).
// Read at call time so tests and a mid-run key rollout are honored.
function loadKey() {
  const raw = process.env.PLAID_TOKEN_ENC_KEY;
  if (!raw) return null;
  return crypto.createHash('sha256').update(String(raw)).digest();
}

function isEncrypted(stored) {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}

// plaintext access_token -> stored form. NULL/empty pass through. With no
// key configured, returns plaintext unchanged (fails open on availability,
// same tradeoff totpCrypto.js makes — this is about ship-ability before a
// key exists, not a security default).
function encryptToken(plain) {
  if (plain == null || plain === '') return plain;
  if (isEncrypted(plain)) return plain; // already encrypted — never double-wrap
  const key = loadKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

// stored form -> plaintext access_token. Legacy plaintext returns unchanged.
// An encrypted value with no/invalid key (or tampered ciphertext) returns
// null so callers fail closed (no Plaid call with a garbage token) rather
// than sending nonsense to Plaid's API.
function decryptToken(stored) {
  if (!isEncrypted(stored)) return stored;
  const key = loadKey();
  if (!key) return null;
  try {
    const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { encryptToken, decryptToken, isEncrypted };
