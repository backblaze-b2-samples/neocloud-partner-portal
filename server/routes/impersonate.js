// /api/impersonate/* — read-only "view as customer" for support purposes.
//
// Admin and support roles can assume a customer user's identity to see what
// the customer sees. All writes are blocked at the requireCsrf chokepoint
// while impersonation is active (see middleware/requireAuth.js).

import express from 'express';
import { requireAuth, requireRole, requireCsrf } from '../middleware/requireAuth.js';
import { setImpersonation, clearImpersonation } from '../auth.js';
import { findById, listUsers } from '../users.js';
import { audit } from '../audit.js';
import { db } from '../db.js';

const STAFF_ROLES_THAT_MAY_IMPERSONATE = new Set(['admin', 'support']);
// Return the *real* staff role for the session — i.e. the impersonator's role
// when impersonating, otherwise the session user's role.
function staffRole(req) {
  return req.session?.impersonator?.role || req.session?.user?.role || null;
}

const router = express.Router();

const CUSTOMER_ROLES = new Set(['customer_admin', 'customer_readonly']);

// Targets list — customer-role users only. Admin OR support may read this
// even though they otherwise can't see the full user list (admin-only).
//
// Each target is enriched with `hasCredentials` and `ejected`. The UI only
// shows users with hasCredentials=true and ejected=false by default, since
// impersonating a phantom account (no stored B2 keys) or an ejected one
// produces nothing useful.
router.get('/targets', requireAuth, requireRole('admin', 'support'), (_req, res) => {
  const credAccountIds = new Set(
    db.prepare('SELECT account_id FROM account_credentials').all().map((r) => r.account_id)
  );
  const ejectedAccountIds = new Set(
    db.prepare('SELECT account_id FROM customer_metadata WHERE ejected_at IS NOT NULL')
      .all().map((r) => r.account_id)
  );
  const targets = listUsers()
    .filter((u) => CUSTOMER_ROLES.has(u.role) && u.active)
    .map((u) => ({
      ...u,
      hasCredentials: !!u.accountId && credAccountIds.has(u.accountId),
      ejected:        !!u.accountId && ejectedAccountIds.has(u.accountId),
    }));
  res.json({ targets });
});

router.post('/start', requireAuth, requireCsrf, (req, res) => {
  // Reject nested impersonation — staff must stop the current one first.
  // (Allowlisted in requireCsrf so this handler actually runs.)
  if (req.session.impersonator) {
    return res.status(409).json({ error: 'Already impersonating. Stop the current session first.' });
  }
  // Gate on the real staff role (not the effective one, which is impossible
  // here since impersonator is null, but kept symmetric with /stop).
  if (!STAFF_ROLES_THAT_MAY_IMPERSONATE.has(staffRole(req))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const targetUserId = Number(req.body?.targetUserId);
  if (!Number.isInteger(targetUserId)) return res.status(400).json({ error: 'targetUserId required' });
  if (targetUserId === req.session.user.id) {
    return res.status(400).json({ error: 'Cannot impersonate yourself.' });
  }
  const target = findById(targetUserId);
  if (!target || !target.active) return res.status(404).json({ error: 'Target user not found.' });
  if (!CUSTOMER_ROLES.has(target.role)) {
    return res.status(403).json({ error: 'Only customer accounts may be impersonated.' });
  }

  setImpersonation(req.session.sid, targetUserId);
  audit({
    actorId: req.session.user.id,
    action:  'impersonation.start',
    targetUserId,
    details: { targetRole: target.role, targetAccountId: target.account_id || null },
    ip:      req.ip,
  });
  res.json({ ok: true });
});

router.post('/stop', requireAuth, requireCsrf, (req, res) => {
  if (!req.session.impersonator) {
    return res.status(400).json({ error: 'Not currently impersonating.' });
  }
  audit({
    actorId: req.session.impersonator.id,
    action:  'impersonation.stop',
    targetUserId: req.session.user.id,
    ip:      req.ip,
  });
  clearImpersonation(req.session.sid);
  res.json({ ok: true });
});

export default router;
