// =============================================================================
// Role repository. All callers go through here; routes never touch db directly.
// Mirrors the shape of server/users.js.
// =============================================================================
// permissionsFor() is on the hot path — getSession() calls it on every single
// request — so role→permissions is cached in-process and invalidated on any
// write. Roles change rarely; sessions do not.
// =============================================================================

import { db } from './db.js';
import { isValidPermission } from './rbac.js';

export const ROLE_SCOPES = ['partner', 'customer'];

const stmtAll         = db.prepare('SELECT * FROM roles ORDER BY scope, id');
const stmtById        = db.prepare('SELECT * FROM roles WHERE id = ?');
const stmtPerms       = db.prepare('SELECT permission FROM role_permissions WHERE role_id = ? ORDER BY permission');
const stmtInsertRole  = db.prepare(
  'INSERT INTO roles (id, name, description, scope, built_in, legacy_id, created_at, updated_at) VALUES (?,?,?,?,0,?,?,?)'
);
const stmtUpdateRole  = db.prepare('UPDATE roles SET name = ?, description = ?, updated_at = ? WHERE id = ?');
const stmtDeleteRole  = db.prepare('DELETE FROM roles WHERE id = ?');
const stmtClearPerms  = db.prepare('DELETE FROM role_permissions WHERE role_id = ?');
const stmtInsertPerm  = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?,?)');
const stmtCountUsers  = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?');

// --- permission cache --------------------------------------------------------

let permCache = new Map();

/** Drop the cache. Call after ANY write to roles or role_permissions. */
export function invalidatePermissionCache() {
  permCache = new Map();
}

/** Set of permission strings granted by a role. Empty set for unknown roles. */
export function permissionsFor(roleId) {
  if (!roleId) return new Set();
  const hit = permCache.get(roleId);
  if (hit) return hit;
  const set = new Set(stmtPerms.all(roleId).map((r) => r.permission));
  permCache.set(roleId, set);
  return set;
}

export function roleHasPermission(roleId, permission) {
  return permissionsFor(roleId).has(permission);
}

// --- reads -------------------------------------------------------------------

export function roleExists(id) {
  return !!stmtById.get(id);
}

export function findRole(id) {
  const row = stmtById.get(id);
  if (!row) return null;
  return publicRole(row);
}

export function listRoles() {
  return stmtAll.all().map(publicRole);
}

/** How many users currently hold this role (blocks deletion). */
export function roleUserCount(id) {
  return stmtCountUsers.get(id).n;
}

export function publicRole(row) {
  if (!row) return null;
  return {
    id:          row.id,
    name:        row.name,
    description: row.description || '',
    scope:       row.scope,
    builtIn:     !!row.built_in,
    permissions: [...permissionsFor(row.id)].sort(),
    userCount:   roleUserCount(row.id),
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  };
}

// --- validation --------------------------------------------------------------

// Role ids are slugs — they end up in users.role, in SSO group mappings, and in
// URLs, so keep them boring.
const ROLE_ID_RE = /^[a-z][a-z0-9_]{1,30}$/;
export function isValidRoleId(id) {
  return typeof id === 'string' && ROLE_ID_RE.test(id);
}

export function isValidScope(scope) {
  return ROLE_SCOPES.includes(scope);
}

/**
 * Keep only well-formed permissions. A customer-scoped role may never hold a
 * partner-only permission — that is the guard which stops a tenant-scoped role
 * from being handed portal-wide authority by an over-eager admin (or by an SSO
 * group mapping).
 */
const CUSTOMER_ALLOWED = new Set([
  'buckets:read', 'files:read', 'reports:read',
  'billing:read', 'mcp:use', 'users:read', 'users:write',
]);

export function sanitizePermissions(permissions, scope) {
  if (!Array.isArray(permissions)) return [];
  const out = new Set();
  for (const p of permissions) {
    if (!isValidPermission(p)) continue;
    if (scope === 'customer' && !CUSTOMER_ALLOWED.has(p)) continue;
    out.add(p);
  }
  return [...out].sort();
}

// --- writes ------------------------------------------------------------------

export function createRole({ id, name, description = '', scope, permissions = [], legacyId = null }) {
  const now = new Date().toISOString();
  const clean = sanitizePermissions(permissions, scope);
  const tx = db.transaction(() => {
    stmtInsertRole.run(id, name, description, scope, legacyId, now, now);
    for (const p of clean) stmtInsertPerm.run(id, p);
  });
  tx();
  invalidatePermissionCache();
  return findRole(id);
}

export function updateRole(id, { name, description, permissions }) {
  const row = stmtById.get(id);
  if (!row) return null;
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    stmtUpdateRole.run(
      name != null ? name : row.name,
      description != null ? description : (row.description || ''),
      now,
      id,
    );
    if (permissions !== undefined) {
      const clean = sanitizePermissions(permissions, row.scope);
      stmtClearPerms.run(id);
      for (const p of clean) stmtInsertPerm.run(id, p);
    }
  });
  tx();
  invalidatePermissionCache();
  return findRole(id);
}

export function deleteRole(id) {
  const tx = db.transaction(() => {
    stmtClearPerms.run(id);
    stmtDeleteRole.run(id);
  });
  tx();
  invalidatePermissionCache();
}
