import express from 'express';
import { hashPassword, generateTempPassword, destroyAllSessionsFor } from '../auth.js';
import { audit } from '../audit.js';
import { requireAuth, requireRole, requireCsrf } from '../middleware/requireAuth.js';
import {
  CUSTOMER_ROLES, findUsersByAccountId, findById, findByEmail, createUser,
  isValidEmail, isStrongPassword, publicUser,
  setRole, setActive, setMustChangePassword, setPasswordHash,
} from '../users.js';

const router = express.Router();
router.use(requireAuth, requireRole('customer_admin'), requireCsrf);

router.get('/users', (req, res) => {
  const { accountId } = req.session.user;
  if (!accountId) return res.status(403).json({ error: 'No account linked to this user' });
  res.json({ users: findUsersByAccountId(accountId) });
});

router.post('/users', async (req, res) => {
  const { accountId } = req.session.user;
  if (!accountId) return res.status(403).json({ error: 'No account linked to this user' });
  const { email, password, role } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });
  if (!isStrongPassword(password)) return res.status(400).json({ error: 'Password must be 8+ characters' });
  if (!CUSTOMER_ROLES.includes(role)) return res.status(400).json({ error: 'Role must be customer_admin or customer_readonly' });
  if (findByEmail(email)) return res.status(409).json({ error: 'Email already in use' });
  const hash = await hashPassword(password);
  const created = createUser({ email, passwordHash: hash, role, accountId, mustChangePassword: true });
  audit({ actorId: req.session.user.id, action: 'customer_user.created', targetUserId: created.id, details: { role, accountId }, ip: req.ip });
  res.status(201).json({ user: publicUser(created) });
});

router.patch('/users/:id', (req, res) => {
  const myAccountId = req.session.user.accountId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const target = findById(id);
  // Guard: both sides must have a non-null accountId, otherwise `null === null`
  // could let a customer_admin (myAccountId=null is impossible but defend anyway)
  // reach a target without an accountId.
  if (!target || !target.account_id || !myAccountId || target.account_id !== myAccountId) {
    return res.status(404).json({ error: 'Not found' });
  }
  const { role, active, mustChangePassword } = req.body || {};
  const changes = [];
  if (role !== undefined) {
    if (!CUSTOMER_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    setRole(id, role);
    changes.push({ field: 'role', from: target.role, to: role });
  }
  if (active !== undefined) {
    setActive(id, !!active);
    if (!active) destroyAllSessionsFor(id);
    changes.push({ field: 'active', to: !!active });
  }
  if (mustChangePassword !== undefined) {
    setMustChangePassword(id, !!mustChangePassword);
    changes.push({ field: 'mustChangePassword', to: !!mustChangePassword });
  }
  if (changes.length === 0) return res.status(400).json({ error: 'No changes' });
  audit({ actorId: req.session.user.id, action: 'customer_user.updated', targetUserId: id, details: { changes }, ip: req.ip });
  res.json({ user: publicUser(findById(id)) });
});

router.post('/users/:id/reset-password', async (req, res) => {
  const myAccountId = req.session.user.accountId;
  const id = Number(req.params.id);
  const target = findById(id);
  // Guard: both sides must have a non-null accountId, otherwise `null === null`
  // could let a customer_admin (myAccountId=null is impossible but defend anyway)
  // reach a target without an accountId.
  if (!target || !target.account_id || !myAccountId || target.account_id !== myAccountId) {
    return res.status(404).json({ error: 'Not found' });
  }
  const temp = generateTempPassword();
  const hash = await hashPassword(temp);
  setPasswordHash(id, hash, 1);
  destroyAllSessionsFor(id);
  audit({ actorId: req.session.user.id, action: 'customer_user.password_reset', targetUserId: id, ip: req.ip });
  res.json({ tempPassword: temp });
});

export default router;
