// =============================================================================
// ssoStore — encrypted storage for the OIDC connection + group→role mappings.
// =============================================================================
// Same shape as server/mcpStore.js. The client secret is encrypted at rest with
// the shared CREDENTIAL_ENCRYPTION_KEY (server/secretbox.js) and is never
// returned to the UI — getConfigPublic() reports presence as hasClientSecret.
//
// (The portal this was ported from stored its client secret as plaintext JSON.
// We already have AES-256-GCM for B2 keys and MCP tokens, so it goes through
// the same path.)
// =============================================================================

import { db } from './db.js';
import { encryptSecret, decryptSecret } from './secretbox.js';

const stmtGet = db.prepare('SELECT * FROM sso_config WHERE id = 1');
const stmtUpsert = db.prepare(`
  INSERT INTO sso_config (id, enabled, issuer_url, client_id, encrypted_client_secret, secret_iv, secret_tag,
                          redirect_uri, groups_claim, button_label, default_role, allow_admin_role, created_at, updated_at)
  VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    enabled                 = excluded.enabled,
    issuer_url              = excluded.issuer_url,
    client_id               = excluded.client_id,
    encrypted_client_secret = excluded.encrypted_client_secret,
    secret_iv               = excluded.secret_iv,
    secret_tag              = excluded.secret_tag,
    redirect_uri            = excluded.redirect_uri,
    groups_claim            = excluded.groups_claim,
    button_label            = excluded.button_label,
    default_role            = excluded.default_role,
    allow_admin_role        = excluded.allow_admin_role,
    updated_at              = excluded.updated_at
`);

const DEFAULTS = {
  enabled: false,
  issuerUrl: '',
  clientId: '',
  hasClientSecret: false,
  redirectUri: '',
  groupsClaim: 'groups',
  buttonLabel: 'Sign in with SSO',
  defaultRole: null,
  allowAdminRole: false,
};

/** Admin-facing config. Never includes the client secret. */
export function getConfigPublic() {
  const row = stmtGet.get();
  if (!row) return { ...DEFAULTS };
  return {
    enabled:         !!row.enabled,
    issuerUrl:       row.issuer_url || '',
    clientId:        row.client_id || '',
    hasClientSecret: !!row.encrypted_client_secret,
    redirectUri:     row.redirect_uri || '',
    groupsClaim:     row.groups_claim || 'groups',
    buttonLabel:     row.button_label || 'Sign in with SSO',
    defaultRole:     row.default_role || null,
    allowAdminRole:  !!row.allow_admin_role,
    updatedAt:       row.updated_at,
  };
}

/**
 * Is SSO actually usable? Enabled alone is not enough — a half-filled config
 * would send users to a broken redirect, so every login path checks this.
 */
export function isSsoUsable() {
  const c = getConfigPublic();
  return !!(c.enabled && c.issuerUrl && c.clientId && c.hasClientSecret);
}

export function setConfig(next) {
  const existing = stmtGet.get();
  const now = new Date().toISOString();

  // An empty/absent clientSecret means "leave the stored one alone" — the UI
  // never receives it, so it cannot send it back.
  let enc = existing
    ? { ciphertext: existing.encrypted_client_secret, iv: existing.secret_iv, tag: existing.secret_tag }
    : { ciphertext: null, iv: null, tag: null };
  if (typeof next.clientSecret === 'string' && next.clientSecret.length > 0) {
    const e = encryptSecret(next.clientSecret);
    enc = { ciphertext: e.ciphertext, iv: e.iv, tag: e.tag };
  }

  stmtUpsert.run(
    next.enabled ? 1 : 0,
    next.issuerUrl || '',
    next.clientId || '',
    enc.ciphertext, enc.iv, enc.tag,
    next.redirectUri || '',
    next.groupsClaim || 'groups',
    next.buttonLabel || 'Sign in with SSO',
    next.defaultRole || null,
    next.allowAdminRole ? 1 : 0,
    existing?.created_at || now,
    now,
  );
  return getConfigPublic();
}

export function getDecryptedClientSecret() {
  const row = stmtGet.get();
  if (!row?.encrypted_client_secret) return null;
  return decryptSecret(row.encrypted_client_secret, row.secret_iv, row.secret_tag);
}

// --- group -> role mappings --------------------------------------------------

const stmtListMappings = db.prepare(
  'SELECT id, group_value, role_id, label, sort_order FROM sso_group_mappings ORDER BY sort_order, id'
);
const stmtInsertMapping = db.prepare(
  'INSERT INTO sso_group_mappings (group_value, role_id, label, sort_order) VALUES (?,?,?,?)'
);
const stmtNextOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM sso_group_mappings');
const stmtGetMapping = db.prepare('SELECT * FROM sso_group_mappings WHERE id = ?');
const stmtUpdateMapping = db.prepare(
  'UPDATE sso_group_mappings SET group_value = ?, role_id = ?, label = ? WHERE id = ?'
);
const stmtDeleteMapping = db.prepare('DELETE FROM sso_group_mappings WHERE id = ?');
const stmtSetOrder = db.prepare('UPDATE sso_group_mappings SET sort_order = ? WHERE id = ?');

function publicMapping(row) {
  if (!row) return null;
  return {
    id: row.id,
    groupValue: row.group_value,
    roleId: row.role_id,
    label: row.label || '',
    sortOrder: row.sort_order,
  };
}

export function listMappings() {
  return stmtListMappings.all().map(publicMapping);
}

export function findMapping(id) {
  return publicMapping(stmtGetMapping.get(id));
}

export function createMapping({ groupValue, roleId, label = '' }) {
  const order = stmtNextOrder.get().n;
  const info = stmtInsertMapping.run(groupValue, roleId, label, order);
  return findMapping(info.lastInsertRowid);
}

export function updateMapping(id, { groupValue, roleId, label }) {
  const row = stmtGetMapping.get(id);
  if (!row) return null;
  stmtUpdateMapping.run(
    groupValue != null ? groupValue : row.group_value,
    roleId != null ? roleId : row.role_id,
    label != null ? label : (row.label || ''),
    id,
  );
  return findMapping(id);
}

export function deleteMapping(id) {
  stmtDeleteMapping.run(id);
}

export function reorderMappings(orderedIds) {
  const tx = db.transaction(() => {
    orderedIds.forEach((id, i) => stmtSetOrder.run(i, id));
  });
  tx();
  return listMappings();
}

/**
 * What in the SSO config points at a role. Used to refuse deleting a role that
 * an identity provider still grants — the foreign keys would reject it anyway,
 * but as an opaque constraint error rather than something an operator can act on.
 */
export function ssoReferencesToRole(roleId) {
  const mappings = db.prepare('SELECT COUNT(*) AS n FROM sso_group_mappings WHERE role_id = ?').get(roleId).n;
  const row = stmtGet.get();
  return { mappings, isDefault: !!row && row.default_role === roleId };
}
