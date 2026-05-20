// /api/auth/* — login, logout, me, change-password.
//
// Login enumerates a constant message regardless of cause (no user / wrong
// password / inactive). Rate limit is checked before DB lookup.

import express from 'express';
import {
  hashPassword, verifyPassword, createSession, destroySession,
  setAuthCookies, clearAuthCookies, SESSION_COOKIE,
} from '../auth.js';
import { audit } from '../audit.js';
import { loginLimiter } from '../rateLimit.js';
import { requireAuth, requireCsrf } from '../middleware/requireAuth.js';
import {
  findByEmail, findById, isValidEmail, isStrongPassword,
  recordLogin, selfUser, setPasswordHash,
} from '../users.js';

const router = express.Router();

router.post('/login', async (req, res) => {
  const limited = loginLimiter(req);
  if (!limited.ok) {
    res.set('Retry-After', String(Math.ceil(limited.retryAfterMs / 1000)));
    return res.status(429).json({ error: 'Too many attempts' });
  }

  const { email, password } = req.body || {};
  if (!isValidEmail(email) || typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ error: 'Invalid credentials' });
  }

  const row = findByEmail(email);
  // Constant-time-ish: always run argon2.verify against a real hash so timing
  // doesn't separate "no user" from "wrong password".
  const decoy = '$argon2id$v=19$m=19456,t=2,p=1$YWFhYWFhYWFhYWFhYWFhYQ$Yz9YPxX9rnlT0V8kFvoH0F1mZpJ8bL8j2sV4Y6m0c5o';
  const hash = row?.password_hash || decoy;
  const ok = await verifyPassword(hash, password);

  if (!row || !ok || !row.active) {
    audit({ actorId: row?.id || null, action: 'auth.login.failed', ip: req.ip });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const sess = createSession({
    userId: row.id,
    ip: req.ip,
    userAgent: req.get('user-agent') || '',
  });
  setAuthCookies(res, sess);
  recordLogin(row.id);
  audit({ actorId: row.id, action: 'auth.login.success', ip: req.ip });

  res.json({ user: selfUser(row) });
});

router.post('/logout', requireCsrf, (req, res) => {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (sid) destroySession(sid);
  if (req.session?.user?.id) {
    audit({ actorId: req.session.user.id, action: 'auth.logout', ip: req.ip });
  }
  clearAuthCookies(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const u = findById(req.session.user.id);
  res.json({ user: selfUser(u) });
});

router.post('/change-password', requireAuth, requireCsrf, async (req, res) => {
  if (req.session.user.email?.endsWith('@demo.com')) {
    return res.status(403).json({ error: 'Password changes are not allowed for demo accounts.' });
  }
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || !isStrongPassword(newPassword)) {
    return res.status(400).json({ error: 'Invalid password' });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'New password must differ from current' });
  }
  const u = findById(req.session.user.id);
  const ok = await verifyPassword(u.password_hash, currentPassword);
  if (!ok) {
    audit({ actorId: u.id, action: 'auth.change_password.failed', ip: req.ip });
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const hash = await hashPassword(newPassword);
  setPasswordHash(u.id, hash, 0); // clears mustChangePassword
  audit({ actorId: u.id, action: 'auth.change_password.success', ip: req.ip });
  res.json({ ok: true });
});

export default router;
