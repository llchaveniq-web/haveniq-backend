const crypto = require('crypto');

// Encrypt the TOTP shared secret at rest so a DB dump can't mint live 2FA
// codes. Stored form is `enc:v1:<base64(iv | authTag | ciphertext)>` using
// AES-256-GCM (authenticated — tampering fails the read).
//
// Deliberately backward-compatible and deploy-safe:
//   • If TOTP_ENC_KEY is NOT set, writes store plaintext and reads pass through
//     unchanged — so this can ship BEFORE the key exists on Railway without
//     breaking any existing 2FA user. Encryption activates the moment the key
//     is set.
//   • Reads accept BOTH the encrypted form and legacy plaintext (pre-encryption
//     rows), so existing enrolled users keep working. Combined with the lazy
//     re-encryption on the login path (routes/twoFactor.js), active users
//     migrate to ciphertext transparently on their next successful 2FA login.
const PREFIX = 'enc:v1:';
const IV_LEN = 12;   // GCM standard nonce
const TAG_LEN = 16;

// Derive a 32-byte key from the env value (any sufficiently strong string).
// Read at call time so tests and a mid-run key rollout are honored.
function loadKey() {
  const raw = process.env.TOTP_ENC_KEY;
  if (!raw) return null;
  return crypto.createHash('sha256').update(String(raw)).digest();
}

function isEncrypted(stored) {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}

// plaintext base32 secret -> stored form. NULL/empty pass through (a disabled
// account stores NULL). With no key configured, returns plaintext unchanged.
function encryptSecret(plain) {
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

// stored form -> plaintext base32 secret. Legacy plaintext returns unchanged.
// An encrypted value with no/invalid key (or tampered ciphertext) returns null
// so verification fails closed rather than checking against garbage.
function decryptSecret(stored) {
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

module.exports = { encryptSecret, decryptSecret, isEncrypted };
