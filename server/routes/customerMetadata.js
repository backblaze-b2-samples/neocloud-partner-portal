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
  const row = getRow(req.params.accountId);
  if (!row) return res.status(404).json({ error: 'No metadata for this account' });
  res.json({ metadata: row });
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
