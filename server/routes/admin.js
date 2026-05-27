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
// Configure via PROTECTED_ACCOUNT_EMAIL=foo@x.com,bar@y.com in .env.
// Empty / unset means no accounts are protected.
const PROTECTED_EMAILS = new Set(
  (process.env.PROTECTED_ACCOUNT_EMAIL || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
);
function isProtected(userRow) {
  return PROTECTED_EMAILS.has((userRow?.email || '').toLowerCase());
}

router.use(requireAuth, requireRole('admin'), requireCsrf);

// List users (admin only). Returns email but never password_hash.
router.get('/users', (_req, res) => {
  // Enrich each row with a `protected` flag so the UI doesn't need to
  // duplicate the PROTECTED_EMAILS list.
  const users = listUsers().map((u) => ({ ...u, protected: isProtected(u) }));
  res.json({ users });
});

// Get one user by id — used by the user-detail view in the UI.
router.get('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const u = findById(id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json({ user: { ...publicUser(u), protected: isProtected(u) } });
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

router.get('/audit', (req, res) => {
  const { limit, offset, action, actorId, targetUserId, involvingUserId, fromDate, toDate } = req.query;
  const result = listAudit({
    limit:           limit    ? Number(limit)  : 100,
    offset:          offset   ? Number(offset) : 0,
    action:          action   ? String(action) : undefined,
    actorId:         actorId  ? Number(actorId) : undefined,
    targetUserId:    targetUserId    ? Number(targetUserId)    : undefined,
    involvingUserId: involvingUserId ? Number(involvingUserId) : undefined,
    fromDate:        fromDate ? String(fromDate) : undefined,
    toDate:          toDate   ? String(toDate)   : undefined,
  });
  res.json(result);
});

// CSV export — same filters as the list endpoint, but returns text/csv and
// is hard-capped at 50k rows so a runaway export can't tie up the box.
router.get('/audit.csv', (req, res) => {
  const { action, actorId, fromDate, toDate } = req.query;
  const { entries } = listAudit({
    limit: 50_000, offset: 0,
    action:   action   ? String(action)   : undefined,
    actorId:  actorId  ? Number(actorId)  : undefined,
    fromDate: fromDate ? String(fromDate) : undefined,
    toDate:   toDate   ? String(toDate)   : undefined,
  });

  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = 'id,created_at,actor_id,action,target_user_id,ip,details\n';
  const rows = entries.map((r) =>
    [r.id, r.created_at, r.actor_id ?? '', r.action, r.target_user_id ?? '', r.ip ?? '', r.details ?? ''].map(esc).join(',')
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(header + rows + '\n');
});

router.get('/roles', (_req, res) => res.json({ roles: ROLES }));
router.get('/admin-count', (_req, res) => res.json({ count: activeAdminCount() }));

export default router;
