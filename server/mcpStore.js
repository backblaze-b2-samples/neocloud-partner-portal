// =============================================================================
// mcpStore — encrypted storage for the MCP server connection + per-customer
// scoped credentials. Credentials are encrypted at rest via secretbox (same key
// as B2 credentials). Public getters never return plaintext.
//
// A credential blob holds EITHER a bearer token (auth_mode 'bearer') OR a JSON
// object of header name→value (auth_mode 'headers', e.g. the four X-B2-* values
// the hosted Backblaze MCP server requires). transport is 'http' (Streamable
// HTTP) or 'sse'. auth_mode/transport are global (one server); the credential
// VALUE is per scope (master + per-account).
// =============================================================================

import { db } from './db.js';
import { encryptSecret, decryptSecret } from './secretbox.js';

// --- mcp_config (single row, id = 1) ----------------------------------------

const stmtGetConfig = db.prepare('SELECT * FROM mcp_config WHERE id = 1');
const stmtUpsertConfig = db.prepare(`
  INSERT INTO mcp_config (id, base_url, enabled, encrypted_token, token_iv, token_tag, transport, auth_mode, header_names, created_at, updated_at)
  VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    base_url       = excluded.base_url,
    enabled        = excluded.enabled,
    encrypted_token = excluded.encrypted_token,
    token_iv       = excluded.token_iv,
    token_tag      = excluded.token_tag,
    transport      = excluded.transport,
    auth_mode      = excluded.auth_mode,
    header_names   = excluded.header_names,
    updated_at     = excluded.updated_at
`);

/** Public config — never includes the credential. `hasToken` reports presence. */
export function getConfigPublic() {
  const row = stmtGetConfig.get();
  if (!row) {
    return { baseUrl: '', enabled: false, hasToken: false, transport: 'http', authMode: 'bearer', headerNames: [] };
  }
  return {
    baseUrl: row.base_url || '',
    enabled: !!row.enabled,
    hasToken: !!row.encrypted_token,
    transport: row.transport || 'http',
    authMode: row.auth_mode || 'bearer',
    headerNames: row.header_names ? safeParseArray(row.header_names) : [],
    updatedAt: row.updated_at,
  };
}

function safeParseArray(s) { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } }

/**
 * Set the connection. The credential is set from `headers` (object → stored as
 * JSON) or `token` (string); if neither is provided the existing credential and
 * header_names are kept (e.g. when only toggling enabled or editing the URL).
 * transport/authMode default to the stored values, then 'http'/'bearer'.
 */
export function setConfig({ baseUrl, enabled, transport, authMode, token, headers }) {
  const now = new Date().toISOString();
  const cur = stmtGetConfig.get();

  let encrypted_token = cur?.encrypted_token ?? null;
  let token_iv = cur?.token_iv ?? null;
  let token_tag = cur?.token_tag ?? null;
  let header_names = cur?.header_names ?? null;

  if (headers && typeof headers === 'object' && Object.keys(headers).length > 0) {
    const e = encryptSecret(JSON.stringify(headers));
    encrypted_token = e.ciphertext; token_iv = e.iv; token_tag = e.tag;
    header_names = JSON.stringify(Object.keys(headers));
  } else if (typeof token === 'string' && token.length > 0) {
    const e = encryptSecret(token);
    encrypted_token = e.ciphertext; token_iv = e.iv; token_tag = e.tag;
    header_names = null; // bearer → no header names
  }

  stmtUpsertConfig.run(
    baseUrl ?? cur?.base_url ?? '',
    enabled ? 1 : 0,
    encrypted_token, token_iv, token_tag,
    transport || cur?.transport || 'http',
    authMode || cur?.auth_mode || 'bearer',
    header_names,
    cur?.created_at || now, now,
  );
  return getConfigPublic();
}

/** Server-only: decrypt the master credential blob (bearer token OR headers JSON). */
export function getDecryptedConfigToken() {
  const row = stmtGetConfig.get();
  if (!row || !row.encrypted_token) return null;
  return decryptSecret(row.encrypted_token, row.token_iv, row.token_tag);
}

// --- mcp_account_tokens (per customer) --------------------------------------

const stmtGetToken = db.prepare('SELECT * FROM mcp_account_tokens WHERE account_id = ?');
const stmtListTokens = db.prepare('SELECT account_id, label, header_names, created_at, updated_at FROM mcp_account_tokens ORDER BY account_id');
const stmtExistsToken = db.prepare('SELECT id FROM mcp_account_tokens WHERE account_id = ?');
const stmtInsertToken = db.prepare(`
  INSERT INTO mcp_account_tokens (account_id, label, encrypted_token, token_iv, token_tag, header_names, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtUpdateToken = db.prepare(`
  UPDATE mcp_account_tokens
  SET label = ?, encrypted_token = ?, token_iv = ?, token_tag = ?, header_names = ?, updated_at = ?
  WHERE account_id = ?
`);
const stmtDeleteToken = db.prepare('DELETE FROM mcp_account_tokens WHERE account_id = ?');

/** List scoped credentials (public fields only — no plaintext). */
export function listAccountTokens() {
  return stmtListTokens.all().map((r) => ({
    accountId: r.account_id,
    label: r.label || '',
    headerNames: r.header_names ? safeParseArray(r.header_names) : [],
    updatedAt: r.updated_at,
  }));
}

/** Store a per-account credential — a bearer `token` or a `headers` object. */
export function upsertAccountToken({ accountId, label, token, headers }) {
  const now = new Date().toISOString();
  let credential, header_names = null;
  if (headers && typeof headers === 'object' && Object.keys(headers).length > 0) {
    credential = JSON.stringify(headers);
    header_names = JSON.stringify(Object.keys(headers));
  } else if (typeof token === 'string' && token.length > 0) {
    credential = token;
  } else {
    throw new Error('token or headers required');
  }
  const { ciphertext, iv, tag } = encryptSecret(credential);
  if (stmtExistsToken.get(accountId)) {
    stmtUpdateToken.run(label ?? '', ciphertext, iv, tag, header_names, now, accountId);
  } else {
    stmtInsertToken.run(accountId, label ?? '', ciphertext, iv, tag, header_names, now, now);
  }
  return { accountId, label: label ?? '' };
}

export function deleteAccountToken(accountId) {
  return stmtDeleteToken.run(accountId).changes > 0;
}

/** Server-only: decrypt a customer's scoped credential blob. Returns null if none. */
export function getDecryptedAccountToken(accountId) {
  const row = stmtGetToken.get(accountId);
  if (!row) return null;
  return decryptSecret(row.encrypted_token, row.token_iv, row.token_tag);
}

export function hasAccountToken(accountId) {
  return !!stmtExistsToken.get(accountId);
}
