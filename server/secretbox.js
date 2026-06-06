// =============================================================================
// secretbox — AES-256-GCM encryption for secrets at rest.
//
// Shared by account_credentials (B2 application keys) and the MCP token store.
// Key: CREDENTIAL_ENCRYPTION_KEY env var (>= 32 chars), SHA-256'd to 32 bytes.
// A random 12-byte IV is generated per write; the 128-bit GCM auth tag is
// stored alongside the ciphertext so tampering is detected on decrypt.
// =============================================================================

import crypto from 'node:crypto';

export function deriveKey() {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY must be set and at least 32 characters. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"'
    );
  }
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

// Returns base64 { ciphertext, iv, tag }.
export function encryptSecret(plaintext) {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function decryptSecret(ciphertext, iv, tag) {
  const key = deriveKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
