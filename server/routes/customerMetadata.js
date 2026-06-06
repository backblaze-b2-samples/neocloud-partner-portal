// =============================================================================
// /api/admin/metadata — per-customer local metadata (plan, pricing overrides, etc.)
//
// Stores fields that live only in this control-plane DB and don't exist in the
// B2 Partner API: display name, industry, plan tier, per-customer price
// overrides (for profit-margin tracking), and admin notes.
//
// All routes require role === 'admin' and a valid CSRF token (on mutations).
//
// Endpoints:
//   GET    /                      List all records
//   GET    /:accountId            Get one record (404 if none yet)
//   PUT    /:accountId            Upsert metadata for one account
//   DELETE /:accountId            Remove metadata for one account
// =============================================================================

import express from 'express';
import { requireAuth, requireRole, requireCsrf } from '../middleware/requireAuth.js';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { findUsersByAccountId, setActive, CUSTOMER_ROLES } from '../users.js';
import { destroyAllSessionsFor } from '../auth.js';

const router = express.Router();

router.use(requireAuth, requireRole('admin'), requireCsrf);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRow(accountId) {
  return db.prepare('SELECT * FROM customer_metadata WHERE account_id = ?').get(accountId) ?? null;
}

// ---------------------------------------------------------------------------
// GET / — list all records
// ---------------------------------------------------------------------------
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM customer_metadata ORDER BY account_id').all();
  res.json({ metadata: rows });
});

// ---------------------------------------------------------------------------
// GET /:accountId
// ---------------------------------------------------------------------------
router.get('/:accountId', (req, res) => {
  // Return 200 with metadata: null when no row exists. This avoids 404 spam
  // in browser Network tabs for the common case of customers without overrides.
  const row = getRow(req.params.accountId);
  res.json({ metadata: row ?? null });
});

// ---------------------------------------------------------------------------
// PUT /:accountId — create or update
// ---------------------------------------------------------------------------
router.put('/:accountId', (req, res) => {
  const { accountId } = req.params;
  const {
    display_name,
    industry,
    plan,
    price_per_gb_storage,
    price_per_gb_download,
    notes,
  } = req.body ?? {};

  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM customer_metadata WHERE account_id = ?').get(accountId);

  if (existing) {
    db.prepare(`
      UPDATE customer_metadata
      SET display_name=?, industry=?, plan=?, price_per_gb_storage=?,
          price_per_gb_download=?, notes=?, updated_at=?
      WHERE account_id=?
    `).run(
      display_name ?? null,
      industry ?? null,
      plan ?? null,
      price_per_gb_storage ?? null,
      price_per_gb_download ?? null,
      notes ?? null,
      now,
      accountId,
    );
  } else {
    db.prepare(`
      INSERT INTO customer_metadata
        (account_id, display_name, industry, plan, price_per_gb_storage, price_per_gb_download, notes, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      accountId,
      display_name ?? null,
      industry ?? null,
      plan ?? null,
      price_per_gb_storage ?? null,
      price_per_gb_download ?? null,
      notes ?? null,
      now,
      now,
    );
  }

  audit({
    actorId: req.session.user.id,
    action: 'metadata.upserted',
    details: { accountId, plan, price_per_gb_storage, price_per_gb_download },
    ip: req.ip,
  });

  res.json({ metadata: getRow(accountId) });
});

// ---------------------------------------------------------------------------
// POST /:accountId/eject — mark a sub-account as ejected from its partner group.
// Snapshots email/group/region so the row can still render after the Partner
// API stops returning it. Upserts metadata if no row exists yet.
// ---------------------------------------------------------------------------
router.post('/:accountId/eject', (req, res) => {
  const { accountId } = req.params;
  const { email, groupId, region, ejectedAt } = req.body ?? {};
  const at  = ejectedAt || new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const existing = db.prepare('SELECT id FROM customer_metadata WHERE account_id = ?').get(accountId);
  if (existing) {
    db.prepare(`
      UPDATE customer_metadata
      SET ejected_at=?, ejected_email=?, ejected_group_id=?, ejected_region=?, updated_at=?
      WHERE account_id=?
    `).run(at, email ?? null, groupId ?? null, region ?? null, now, accountId);
  } else {
    db.prepare(`
      INSERT INTO customer_metadata
        (account_id, ejected_at, ejected_email, ejected_group_id, ejected_region, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(accountId, at, email ?? null, groupId ?? null, region ?? null, now, now);
  }

  audit({
    actorId: req.session.user.id,
    action: 'metadata.ejected',
    details: { accountId, groupId, ejectedAt: at },
    ip: req.ip,
  });

  // Cascade: revoke every customer-portal login tied to this account.
  // Otherwise an ejected customer could still sign in and see (cached) data
  // until the next time someone manually deactivated their user row.
  const affected = cascadeEjectionToUsers(accountId, req.session.user.id, req.ip);

  res.json({ metadata: getRow(accountId), revokedUserIds: affected });
});

// Helper: deactivate every active customer user on an account and kill their
// sessions. Returns the list of user ids that were actually changed (so the
// matching restore handler can flip them back).
function cascadeEjectionToUsers(accountId, actorId, ip) {
  const users = findUsersByAccountId(accountId)
    .filter((u) => CUSTOMER_ROLES.includes(u.role) && u.active);
  for (const u of users) {
    setActive(u.id, false);
    destroyAllSessionsFor(u.id);
    audit({
      actorId,
      action: 'customer_user.deactivated_by_ejection',
      targetUserId: u.id,
      details: { accountId },
      ip,
    });
  }
  return users.map((u) => u.id);
}

// ---------------------------------------------------------------------------
// POST /:accountId/restore — clear the ejected flag (re-mark account active).
// ---------------------------------------------------------------------------
router.post('/:accountId/restore', (req, res) => {
  const { accountId } = req.params;
  const now = new Date().toISOString();
  const changes = db.prepare(`
    UPDATE customer_metadata
    SET ejected_at=NULL, ejected_email=NULL, ejected_group_id=NULL, ejected_region=NULL, updated_at=?
    WHERE account_id=?
  `).run(now, accountId).changes;
  if (!changes) return res.status(404).json({ error: 'No metadata for this account' });

  audit({
    actorId: req.session.user.id,
    action: 'metadata.restored',
    details: { accountId },
    ip: req.ip,
  });

  // Inverse cascade: reactivate the customer logins that ejection knocked out.
  // We re-enable every inactive customer user on this account — an admin who
  // disabled a user for unrelated reasons should re-disable them after restore.
  const reactivated = cascadeRestoreToUsers(accountId, req.session.user.id, req.ip);

  res.json({ metadata: getRow(accountId), reactivatedUserIds: reactivated });
});

function cascadeRestoreToUsers(accountId, actorId, ip) {
  const users = findUsersByAccountId(accountId)
    .filter((u) => CUSTOMER_ROLES.includes(u.role) && !u.active);
  for (const u of users) {
    setActive(u.id, true);
    audit({
      actorId,
      action: 'customer_user.reactivated_by_restore',
      targetUserId: u.id,
      details: { accountId },
      ip,
    });
  }
  return users.map((u) => u.id);
}

// ---------------------------------------------------------------------------
// DELETE /:accountId
// ---------------------------------------------------------------------------
router.delete('/:accountId', (req, res) => {
  const changes = db.prepare('DELETE FROM customer_metadata WHERE account_id = ?').run(req.params.accountId).changes;
  if (!changes) return res.status(404).json({ error: 'No metadata for this account' });

  audit({
    actorId: req.session.user.id,
    action: 'metadata.deleted',
    details: { accountId: req.params.accountId },
    ip: req.ip,
  });

  res.json({ deleted: true });
});

export default router;
