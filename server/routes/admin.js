// /api/admin/* — admin-only user management.
//
// All routes require role === 'admin' and CSRF token. Privilege-escalation
// checks live here too: a non-admin can never reach these handlers, but we
// also defensively reject role changes to/from admin from anyone but admin
// (currently moot — only admins can call this — but keeps the check local
// in case the middleware is loosened later).

import express from 'express';
import { hashPassword, generateTempPassword, destroyAllSessionsFor } from '../auth.js';
import { audit, listAudit } from '../audit.js';
import { requireAuth, requireRole, requireCsrf } from '../middleware/requireAuth.js';
import {
  ROLES, CUSTOMER_ROLES, listUsers, findById, findByEmail, createUser,
  isValidEmail, isStrongPassword, isValidRole,
  setRole, setActive, setMustChangePassword, setPasswordHash,
  activeAdminCount, activeAdminCountExcept, publicUser, findUsersByAccountId,
} from '../users.js';

const router = express.Router();

// Accounts that cannot be modified, force-reset, or deactivated by anyone.
const PROTECTED_EMAILS = new Set(
  (process.env.PROTECTED_ACCOUNT_EMAIL || 'klott@backblaze.com,demo@backblaze.com')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
);
function isProtected(userRow) {
  return PROTECTED_EMAILS.has((userRow?.email || '').toLowerCase());
}

router.use(requireAuth, requireRole('admin'), requireCsrf);

// List users (admin only). Returns email but never password_hash.
router.get('/users', (_req, res) => {
  res.json({ users: listUsers() });
});

router.post('/users', async (req, res) => {
  const { email, password, role, accountId } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });
  if (!isStrongPassword(password)) return res.status(400).json({ error: 'Password must be 8+ characters' });
  if (!isValidRole(role)) return res.status(400).json({ error: 'Invalid role' });
  if (CUSTOMER_ROLES.includes(role) && !accountId) return res.status(400).json({ error: 'accountId is required for customer roles' });
  if (findByEmail(email)) return res.status(409).json({ error: 'Email already in use' });

  const hash = await hashPassword(password);
  const created = createUser({ email, passwordHash: hash, role, accountId: accountId || null, mustChangePassword: true });
  audit({
    actorId: req.session.user.id, action: 'user.created',
    targetUserId: created.id, details: { role }, ip: req.ip,
  });
  res.status(201).json({ user: publicUser(created) });
});

router.patch('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const target = findById(id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  if (isProtected(target)) return res.status(403).json({ error: 'This account is protected and cannot be modified.' });

  const { role, active, mustChangePassword } = req.body || {};
  const changes = [];

  if (role !== undefined) {
    if (!isValidRole(role)) return res.status(400).json({ error: 'Invalid role' });
    // Last-admin protection: don't let an admin demote themselves if they're
    // the last active admin.
    if (target.role === 'admin' && role !== 'admin' && activeAdminCountExcept(id) === 0) {
      return res.status(409).json({ error: 'Cannot demote the last active admin' });
    }
    setRole(id, role);
    changes.push({ field: 'role', from: target.role, to: role });
  }

  if (active !== undefined) {
    const want = !!active;
    // Last-admin protection on deactivation.
    if (target.role === 'admin' && want === false && activeAdminCountExcept(id) === 0) {
      return res.status(409).json({ error: 'Cannot deactivate the last active admin' });
    }
    setActive(id, want);
    changes.push({ field: 'active', from: !!target.active, to: want });
    if (!want) destroyAllSessionsFor(id); // kick existing sessions
  }

  if (mustChangePassword !== undefined) {
    setMustChangePassword(id, !!mustChangePassword);
    changes.push({ field: 'mustChangePassword', to: !!mustChangePassword });
  }

  if (changes.length === 0) return res.status(400).json({ error: 'No changes' });

  audit({
    actorId: req.session.user.id, action: 'user.updated',
    targetUserId: id, details: { changes }, ip: req.ip,
  });

  res.json({ user: publicUser(findById(id)) });
});

router.post('/users/:id/reset-password', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const target = findById(id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  if (isProtected(target)) return res.status(403).json({ error: 'This account is protected and cannot be modified.' });

  const temp = generateTempPassword();
  const hash = await hashPassword(temp);
  setPasswordHash(id, hash, 1); // force change on next login
  destroyAllSessionsFor(id);
  audit({
    actorId: req.session.user.id, action: 'user.password_reset',
    targetUserId: id, ip: req.ip,
  });
  // Returning the temp password is acceptable here because only admins reach
  // this endpoint and they need to relay it to the user out-of-band.
  res.json({ tempPassword: temp });
});

router.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const target = findById(id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  if (isProtected(target)) return res.status(403).json({ error: 'This account is protected and cannot be modified.' });
  if (target.role === 'admin' && activeAdminCountExcept(id) === 0) {
    return res.status(409).json({ error: 'Cannot deactivate the last active admin' });
  }
  // Soft delete: deactivate rather than DELETE FROM, so audit trail and FKs stay valid.
  setActive(id, false);
  destroyAllSessionsFor(id);
  audit({
    actorId: req.session.user.id, action: 'user.deactivated',
    targetUserId: id, ip: req.ip,
  });
  res.json({ user: publicUser(findById(id)) });
});

router.get('/audit', (_req, res) => {
  res.json({ entries: listAudit({ limit: 200 }) });
});

router.get('/roles', (_req, res) => res.json({ roles: ROLES }));
router.get('/admin-count', (_req, res) => res.json({ count: activeAdminCount() }));

export default router;
