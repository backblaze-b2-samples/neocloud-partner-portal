// =============================================================================
// mcpStore — encrypted storage for the MCP server connection + per-customer
// scoped tokens. Tokens are encrypted at rest via secretbox (same key as B2
// credentials). Public getters never return plaintext tokens.
// =============================================================================

import { db } from './db.js';
import { encryptSecret, decryptSecret } from './secretbox.js';

// --- mcp_config (single row, id = 1) ----------------------------------------

const stmtGetConfig = db.prepare('SELECT * FROM mcp_config WHERE id = 1');
const stmtUpsertConfig = db.prepare(`
  INSERT INTO mcp_config (id, base_url, enabled, encrypted_token, token_iv, token_tag, created_at, updated_at)
  VALUES (1, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    base_url = excluded.base_url,
    enabled = excluded.enabled,
    encrypted_token = COALESCE(excluded.encrypted_token, mcp_config.encrypted_token),
    token_iv = COALESCE(excluded.token_iv, mcp_config.token_iv),
    token_tag = COALESCE(excluded.token_tag, mcp_config.token_tag),
    updated_at = excluded.updated_at
`);

/** Public config — never includes the token. `hasToken` reports presence. */
export function getConfigPublic() {
  const row = stmtGetConfig.get();
  if (!row) return { baseUrl: '', enabled: false, hasToken: false };
  return {
    baseUrl: row.base_url || '',
    enabled: !!row.enabled,
    hasToken: !!row.encrypted_token,
    updatedAt: row.updated_at,
  };
}

/**
 * Set the connection. `token` is optional — omit/undefined to keep the existing
 * token (e.g. when only toggling enabled or editing the URL).
 */
export function setConfig({ baseUrl, enabled, token }) {
  const now = new Date().toISOString();
  let enc = { ciphertext: null, iv: null, tag: null };
  if (typeof token === 'string' && token.length > 0) {
    enc = encryptSecret(token);
  }
  stmtUpsertConfig.run(
    baseUrl ?? '', enabled ? 1 : 0,
    enc.ciphertext, enc.iv, enc.tag,
    now, now,
  );
  return getConfigPublic();
}

/** Server-only: decrypt the master token. Returns null if unset. */
export function getDecryptedConfigToken() {
  const row = stmtGetConfig.get();
  if (!row || !row.encrypted_token) return null;
  return decryptSecret(row.encrypted_token, row.token_iv, row.token_tag);
}

// --- mcp_account_tokens (per customer) --------------------------------------

const stmtGetToken = db.prepare('SELECT * FROM mcp_account_tokens WHERE account_id = ?');
const stmtListTokens = db.prepare('SELECT account_id, label, created_at, updated_at FROM mcp_account_tokens ORDER BY account_id');
const stmtExistsToken = db.prepare('SELECT id FROM mcp_account_tokens WHERE account_id = ?');
const stmtInsertToken = db.prepare(`
  INSERT INTO mcp_account_tokens (account_id, label, encrypted_token, token_iv, token_tag, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const stmtUpdateToken = db.prepare(`
  UPDATE mcp_account_tokens
  SET label = ?, encrypted_token = ?, token_iv = ?, token_tag = ?, updated_at = ?
  WHERE account_id = ?
`);
const stmtDeleteToken = db.prepare('DELETE FROM mcp_account_tokens WHERE account_id = ?');

/** List scoped tokens (public fields only — no plaintext). */
export function listAccountTokens() {
  return stmtListTokens.all().map((r) => ({
    accountId: r.account_id, label: r.label || '', updatedAt: r.updated_at,
  }));
}

export function upsertAccountToken({ accountId, label, token }) {
  const now = new Date().toISOString();
  const { ciphertext, iv, tag } = encryptSecret(token);
  if (stmtExistsToken.get(accountId)) {
    stmtUpdateToken.run(label ?? '', ciphertext, iv, tag, now, accountId);
  } else {
    stmtInsertToken.run(accountId, label ?? '', ciphertext, iv, tag, now, now);
  }
  return { accountId, label: label ?? '' };
}

export function deleteAccountToken(accountId) {
  return stmtDeleteToken.run(accountId).changes > 0;
}

/** Server-only: decrypt a customer's scoped token. Returns null if none. */
export function getDecryptedAccountToken(accountId) {
  const row = stmtGetToken.get(accountId);
  if (!row) return null;
  return decryptSecret(row.encrypted_token, row.token_iv, row.token_tag);
}

export function hasAccountToken(accountId) {
  return !!stmtExistsToken.get(accountId);
}
