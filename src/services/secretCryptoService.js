const crypto = require('crypto');

// AES-256-GCM. The ciphertext is stored as a self-describing string so the format
// can be recognised (and rotated) without a schema change:
//   enc:v1:<iv-base64>:<authTag-base64>:<ciphertext-base64>
const PREFIX = 'enc:v1';
const IV_BYTES = 12;

function getKeyMaterial() {
  return process.env.SECRET_ENCRYPTION_KEY || process.env.SECRET_ENCRYPTION_KEY_BASE64 || '';
}

function isEncryptionConfigured() {
  return getKeyMaterial().trim().length > 0;
}

/**
 * Accepts either a 32-byte base64/hex key or an arbitrary passphrase. A passphrase
 * is stretched with scrypt so a short value cannot silently become a weak key.
 */
function getKey() {
  const raw = getKeyMaterial().trim();
  if (!raw) {
    throw new Error('SECRET_ENCRYPTION_KEY is not configured, so client secrets cannot be stored securely.');
  }

  for (const encoding of ['base64', 'hex']) {
    try {
      const decoded = Buffer.from(raw, encoding);
      if (decoded.length === 32 && decoded.toString(encoding).replace(/=+$/, '') === raw.replace(/=+$/, '')) {
        return decoded;
      }
    } catch {
      // Not this encoding; fall through to the passphrase path.
    }
  }
  return crypto.scryptSync(raw, 'pbi-governance-secret-v1', 32);
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(`${PREFIX}:`);
}

function encryptSecret(plainText) {
  if (plainText === null || plainText === undefined || plainText === '') return null;
  if (isEncrypted(plainText)) return plainText;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function decryptSecret(stored) {
  if (stored === null || stored === undefined || stored === '') return null;
  if (!isEncrypted(stored)) {
    // A legacy plaintext value. Returning it keeps existing installs working, but
    // it is re-encrypted the next time the service principal is saved.
    return String(stored);
  }

  const parts = String(stored).split(':');
  if (parts.length !== 5) throw new Error('Stored client secret is malformed.');
  const [, , ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  isEncryptionConfigured,
};
