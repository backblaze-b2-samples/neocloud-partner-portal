// =============================================================================
// credentials — encrypted storage for B2 sub-account credentials.
//
// applicationKey is encrypted at rest with AES-256-GCM.
// applicationKeyId and region are not secrets and are stored in plaintext.
//
// Encryption key: CREDENTIAL_ENCRYPTION_KEY env var (min 32 chars).
// A random 12-byte IV is generated per write; the GCM auth tag is stored
// alongside the ciphertext so any tampering is detected on decrypt.
//
// The raw applicationKey is NEVER returned by list/get helpers.
// Call getDecryptedApplicationKey() only for server-side operations that
// genuinely need it (e.g. seeding scripts authorizing as a sub-account).
// =============================================================================

import crypto from 'node:crypto';
import { db } from './db.js';

// ---------------------------------------------------------------------------
// Encryption helpers
// ---------------------------------------------------------------------------

function deriveKey() {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY must be set and at least 32 characters. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"'
    );
  }
  // SHA-256 the env value to always get a 32-byte AES key, regardless of input length.
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function encrypt(plaintext) {
  const key = deriveKey();
  const iv  = crypto.randomBytes(12); // 96-bit IV recommended for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // 128-bit auth tag
  return {
    encryptedApplicationKey: ciphertext.toString('base64'),
    keyIv:  iv.toString('base64'),
    keyTag: tag.toString('base64'),
  };
}

function decrypt(encryptedApplicationKey, keyIv, keyTag) {
  const key = deriveKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(keyIv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(keyTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedApplicationKey, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const stmtInsert = db.prepare(`
  INSERT INTO account_credentials
    (account_id, email, group_id, region, application_key_id,
     encrypted_application_key, key_iv, key_tag, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtUpdate = db.prepare(`
  UPDATE account_credentials
  SET email = ?, group_id = ?, region = ?, application_key_id = ?,
      encrypted_application_key = ?, key_iv = ?, key_tag = ?, updated_at = ?
  WHERE account_id = ?
`);

const stmtSelectPublic = db.prepare(`
  SELECT id, account_id, email, group_id, region, application_key_id,
         created_at, updated_at
  FROM account_credentials
  WHERE account_id = ?
`);

const stmtSelectSecret = db.prepare(`
  SELECT encrypted_application_key, key_iv, key_tag
  FROM account_credentials
  WHERE account_id = ?
`);

const stmtListPublic = db.prepare(`
  SELECT id, account_id, email, group_id, region, application_key_id,
         created_at, updated_at
  FROM account_credentials
  ORDER BY group_id, email
`);

const stmtListByGroup = db.prepare(`
  SELECT id, account_id, email, group_id, region, application_key_id,
         created_at, updated_at
  FROM account_credentials
  WHERE group_id = ?
  ORDER BY email
`);

const stmtDelete = db.prepare(`DELETE FROM account_credentials WHERE account_id = ?`);

const stmtExists = db.prepare(`SELECT id FROM account_credentials WHERE account_id = ?`);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store (or update) credentials for a B2 sub-account.
 * applicationKey is encrypted before writing; it is never persisted in plaintext.
 */
export function upsertCredential({ accountId, email, groupId, region, applicationKeyId, applicationKey }) {
  const now = new Date().toISOString();
  const { encryptedApplicationKey, keyIv, keyTag } = encrypt(applicationKey);

  if (stmtExists.get(accountId)) {
    stmtUpdate.run(
      email, groupId, region, applicationKeyId,
      encryptedApplicationKey, keyIv, keyTag,
      now, accountId
    );
  } else {
    stmtInsert.run(
      accountId, email, groupId, region, applicationKeyId,
      encryptedApplicationKey, keyIv, keyTag,
      now, now
    );
  }

  return getCredential(accountId);
}

/**
 * Return the public (non-secret) fields for one account.
 * Never includes the applicationKey or encryption internals.
 */
export function getCredential(accountId) {
  return stmtSelectPublic.get(accountId) ?? null;
}

/**
 * Return all accounts — public fields only.
 * Optionally filter by groupId.
 */
export function listCredentials({ groupId } = {}) {
  return groupId ? stmtListByGroup.all(groupId) : stmtListPublic.all();
}

/**
 * Decrypt and return the raw applicationKey for a given accountId.
 * Call this only for server-side operations (seeding, live API proxying).
 * Never forward the return value to an HTTP response body directly.
 */
export function getDecryptedApplicationKey(accountId) {
  const row = stmtSelectSecret.get(accountId);
  if (!row) return null;
  return decrypt(row.encrypted_application_key, row.key_iv, row.key_tag);
}

/**
 * Remove credentials for an account.
 */
export function deleteCredential(accountId) {
  const changes = stmtDelete.run(accountId).changes;
  return changes > 0;
}
