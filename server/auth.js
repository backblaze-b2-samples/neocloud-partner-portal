// =============================================================================
// auth — password hashing, session create/lookup/destroy, CSRF token issue.
// =============================================================================
// Sessions live server-side in SQLite. The browser only ever sees:
//   - "sid"  cookie: opaque random session id, httpOnly, Secure, SameSite=Strict
//   - "csrf" cookie: random token, NOT httpOnly so JS can read it and echo it
//                    back in the X-CSRF-Token header (double-submit pattern)
// =============================================================================

import crypto from 'node:crypto';
import argon2 from 'argon2';
import { db } from './db.js';

export const SESSION_COOKIE = 'sid';
export const CSRF_COOKIE = 'csrf';
const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours

const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plain) {
  return argon2.hash(plain, ARGON2_OPTS);
}

export async function verifyPassword(hash, plain) {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

const insertSession = db.prepare(`
  INSERT INTO sessions (id, user_id, csrf_token, created_at, expires_at, ip, user_agent)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
// Session lookup. LEFT JOINs the impersonation target so a single query
// returns both the staff actor (u) and the effective user (t) when active.
const selectSession = db.prepare(`
  SELECT s.id, s.user_id, s.csrf_token, s.expires_at, s.impersonating_user_id,
         u.id AS uid, u.email, u.role, u.account_id, u.active, u.must_change_password,
         t.id  AS tid, t.email AS t_email, t.role AS t_role, t.account_id AS t_account_id,
         t.active AS t_active, t.must_change_password AS t_must_change_password
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  LEFT JOIN users t ON t.id = s.impersonating_user_id
  WHERE s.id = ? AND s.expires_at > ?
`);
const deleteSession = db.prepare(`DELETE FROM sessions WHERE id = ?`);
const deleteUserSessions = db.prepare(`DELETE FROM sessions WHERE user_id = ?`);
const setImpersonationStmt   = db.prepare(`UPDATE sessions SET impersonating_user_id = ? WHERE id = ?`);
const clearImpersonationStmt = db.prepare(`UPDATE sessions SET impersonating_user_id = NULL WHERE id = ?`);

export function createSession({ userId, ip, userAgent }) {
  const sid = randomToken(32);
  const csrf = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  insertSession.run(sid, userId, csrf, now.toISOString(), expires.toISOString(), ip || null, (userAgent || '').slice(0, 256));
  return { sid, csrf, expires };
}

export function getSession(sid) {
  if (!sid || typeof sid !== 'string') return null;
  const row = selectSession.get(sid, new Date().toISOString());
  if (!row) return null;
  if (!row.active) return null;

  // If the staff session is impersonating a customer, the *effective* user
  // (role + accountId everything else checks against) is the target.
  // The original staff identity is exposed as `impersonator` so the audit
  // log can attribute actions back to the real person.
  if (row.impersonating_user_id && row.tid && row.t_active) {
    return {
      sid:  row.id,
      csrf: row.csrf_token,
      user: {
        id: row.tid,
        email: row.t_email,
        role: row.t_role,
        accountId: row.t_account_id || null,
        active: !!row.t_active,
        mustChangePassword: !!row.t_must_change_password,
      },
      impersonator: {
        id: row.uid,
        email: row.email,
        role: row.role,
      },
    };
  }

  return {
    sid: row.id,
    csrf: row.csrf_token,
    user: {
      id: row.uid,
      email: row.email,
      role: row.role,
      accountId: row.account_id || null,
      active: !!row.active,
      mustChangePassword: !!row.must_change_password,
    },
  };
}

export function setImpersonation(sid, targetUserId) {
  setImpersonationStmt.run(targetUserId, sid);
}
export function clearImpersonation(sid) {
  clearImpersonationStmt.run(sid);
}

export function destroySession(sid) {
  if (sid) deleteSession.run(sid);
}

export function destroyAllSessionsFor(userId) {
  deleteUserSessions.run(userId);
}

// Cookie helpers
const isProd = () => process.env.NODE_ENV === 'production';

export function setAuthCookies(res, { sid, csrf, expires }) {
  const baseFlags = ['Path=/', 'SameSite=Strict'];
  if (isProd()) baseFlags.push('Secure');
  const expiresStr = `Expires=${expires.toUTCString()}`;
  res.append('Set-Cookie', [`${SESSION_COOKIE}=${sid}`, 'HttpOnly', expiresStr, ...baseFlags].join('; '));
  // CSRF cookie: NOT HttpOnly so the SPA can echo it in X-CSRF-Token.
  res.append('Set-Cookie', [`${CSRF_COOKIE}=${csrf}`, expiresStr, ...baseFlags].join('; '));
}

export function clearAuthCookies(res) {
  const baseFlags = ['Path=/', 'SameSite=Strict', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
  if (isProd()) baseFlags.push('Secure');
  res.append('Set-Cookie', [`${SESSION_COOKIE}=`, 'HttpOnly', ...baseFlags].join('; '));
  res.append('Set-Cookie', [`${CSRF_COOKIE}=`, ...baseFlags].join('; '));
}

// Random temporary password for admin-initiated resets. 16 base32 chars.
export function generateTempPassword() {
  return crypto.randomBytes(12).toString('base64url').slice(0, 16);
}
