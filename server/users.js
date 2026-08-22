// User repository. All callers go through here; routes never touch db directly.

import { db } from './db.js';
import { roleExists } from './roles.js';

// The BUILT-IN role ids. Operators can define more (see server/roles.js), so
// these lists are no longer the full set of valid roles — use isValidRole() for
// validation and the roles table for enumeration. They remain the source of
// truth for the two hardcoded behaviours that are about *tenancy*, not
// permissions: customer roles require an account_id, partner roles must not
// have one.
export const ROLES = ['admin', 'manager', 'user', 'support', 'customer_admin', 'customer_readonly'];
export const PARTNER_ROLES = ['admin', 'manager', 'user', 'support'];
export const CUSTOMER_ROLES = ['customer_admin', 'customer_readonly'];

const insert = db.prepare(`
  INSERT INTO users (email, password_hash, role, account_id, active, must_change_password, created_at, updated_at)
  VALUES (?, ?, ?, ?, 1, ?, ?, ?)
`);
const byEmail = db.prepare(`SELECT * FROM users WHERE email = ?`);
const byId = db.prepare(`SELECT * FROM users WHERE id = ?`);
const all = db.prepare(`SELECT id, email, role, account_id, active, must_change_password, auth_source, created_at, updated_at, last_login_at FROM users ORDER BY id`);
const allByAccountId = db.prepare(`SELECT id, email, role, account_id, active, must_change_password, auth_source, created_at, updated_at, last_login_at FROM users WHERE account_id = ? ORDER BY id`);
const updatePw = db.prepare(`UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?`);
const updateLogin = db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`);
const updateRole = db.prepare(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`);
const updateActive = db.prepare(`UPDATE users SET active = ?, updated_at = ? WHERE id = ?`);
const setForceReset = db.prepare(`UPDATE users SET must_change_password = ?, updated_at = ? WHERE id = ?`);
const countActiveAdmins = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1`);
const countActiveAdminsExcept = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?`);
const countLocalAdminsExcept = db.prepare(
  `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND auth_source = 'local' AND id != ?`
);
const updateAuthSource = db.prepare(`UPDATE users SET auth_source = ?, updated_at = ? WHERE id = ?`);

function normalizeEmail(e) {
  return String(e || '').trim().toLowerCase();
}

export function isValidEmail(e) {
  if (typeof e !== 'string') return false;
  const s = e.trim();
  if (s.length < 3 || s.length > 254) return false;
  // Conservative pattern; sufficient validation, not full RFC 5322.
  return /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(s);
}

// Validates against the roles TABLE, not the built-in list, so operator-defined
// roles can be assigned to users.
export function isValidRole(r) {
  return typeof r === 'string' && r.length > 0 && roleExists(r);
}

export function isStrongPassword(pw) {
  if (typeof pw !== 'string') return false;
  if (pw.length < 8 || pw.length > 200) return false;
  return true;
}

export function findByEmail(email) {
  return byEmail.get(normalizeEmail(email));
}

export function findById(id) {
  return byId.get(id);
}

export function listUsers() {
  return all.all().map(publicUser);
}

export function createUser({ email, passwordHash, role, accountId = null, mustChangePassword = false }) {
  const now = new Date().toISOString();
  const info = insert.run(normalizeEmail(email), passwordHash, role, accountId, mustChangePassword ? 1 : 0, now, now);
  return findById(info.lastInsertRowid);
}

export function findUsersByAccountId(accountId) {
  return allByAccountId.all(accountId).map(publicUser);
}

export function setPasswordHash(userId, passwordHash, mustChangePassword = 0) {
  updatePw.run(passwordHash, mustChangePassword ? 1 : 0, new Date().toISOString(), userId);
}

export function recordLogin(userId) {
  updateLogin.run(new Date().toISOString(), userId);
}

export function setRole(userId, role) {
  if (!isValidRole(role)) throw new Error('invalid role');
  updateRole.run(role, new Date().toISOString(), userId);
}

export function setActive(userId, active) {
  updateActive.run(active ? 1 : 0, new Date().toISOString(), userId);
}

export function setMustChangePassword(userId, value) {
  setForceReset.run(value ? 1 : 0, new Date().toISOString(), userId);
}

/**
 * Move a user between password login and SSO.
 *
 * Converting is deliberately an admin action rather than something an SSO login
 * does on its own: an IdP asserting an email address must not be able to take
 * over an existing password account. Doing it here keeps the user row, its id,
 * and its audit history intact, which matters when migrating a team that is
 * already using the portal.
 */
export function setAuthSource(userId, authSource) {
  if (authSource !== 'local' && authSource !== 'sso') throw new Error('invalid auth source');
  updateAuthSource.run(authSource, new Date().toISOString(), userId);
}

/**
 * Active admins who can still sign in WITHOUT the identity provider, excluding
 * one. If this reaches zero, an IdP outage locks everyone out of administration
 * — so converting the last local admin to SSO is refused.
 */
export function localAdminCountExcept(userId) {
  return countLocalAdminsExcept.get(userId).n;
}

// Last-admin protection.
export function activeAdminCount() {
  return countActiveAdmins.get().n;
}
export function activeAdminCountExcept(userId) {
  return countActiveAdminsExcept.get(userId).n;
}

// Public projection — never include password_hash.
export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    accountId: row.account_id || null,
    active: !!row.active,
    mustChangePassword: !!row.must_change_password,
    authSource: row.auth_source || 'local',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

// "Self" projection: returned to a logged-in user by /api/auth/me.
// Same shape as publicUser — the user is allowed to see their own email.
export function selfUser(row) {
  return publicUser(row);
}
