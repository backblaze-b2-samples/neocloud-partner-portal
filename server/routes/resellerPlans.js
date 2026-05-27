// =============================================================================
// /api/admin/reseller-plans — read/update reseller pricing tiers.
//
// On first call, seeds the DB table from the static defaults in
// src/data/resellerPlans.js so the table is never empty. Admin can then edit
// the values; the file remains a fallback if the DB read ever fails.
//
// Endpoints:
//   GET  /                 List all plans (ordered by position, then id)
//   PUT  /:id              Update one plan (admin only, CSRF required)
// =============================================================================

import express from 'express';
import { requireAuth, requireRole, requireCsrf } from '../middleware/requireAuth.js';
import { db } from '../db.js';
import { audit } from '../audit.js';

const router = express.Router();

// Default seed values — kept in sync with src/data/resellerPlans.js.
// Duplicated here because the server runs in Node and that file is in src/ —
// pulling it in via import works under Vite but is awkward server-side.
const SEED_DEFAULTS = [
  { id: 'tier-1', name: 'Reseller — Tier 1', description: 'Standard reseller — highest markup',
    storage_per_tb: 25, egress_per_gb: 0.030,
    class_a_per_10k: 0.004, class_b_per_10k: 0.004, class_c_per_10k: 0.002, class_d_per_10k: 0.012,
    position: 1 },
  { id: 'tier-2', name: 'Reseller — Tier 2', description: 'Growth tier — mid markup',
    storage_per_tb: 15, egress_per_gb: 0.020,
    class_a_per_10k: 0.002, class_b_per_10k: 0.002, class_c_per_10k: 0.001, class_d_per_10k: 0.008,
    position: 2 },
  { id: 'tier-3', name: 'Reseller — Tier 3', description: 'Enterprise volume — lowest markup; mirrors B2 list',
    storage_per_tb: 10, egress_per_gb: 0.015,
    class_a_per_10k: 0, class_b_per_10k: 0, class_c_per_10k: 0, class_d_per_10k: 0.005,
    position: 3 },
];

function seedIfEmpty() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM reseller_plans').get();
  if (n > 0) return;
  const now = new Date().toISOString();
  const ins = db.prepare(`
    INSERT INTO reseller_plans
      (id, name, description, storage_per_tb, egress_per_gb,
       class_a_per_10k, class_b_per_10k, class_c_per_10k, class_d_per_10k,
       position, updated_at)
    VALUES
      (@id, @name, @description, @storage_per_tb, @egress_per_gb,
       @class_a_per_10k, @class_b_per_10k, @class_c_per_10k, @class_d_per_10k,
       @position, @updated_at)
  `);
  const tx = db.transaction((rows) => {
    for (const r of rows) ins.run({ ...r, updated_at: now });
  });
  tx(SEED_DEFAULTS);
}

// Seed once on module load. Safe: only writes if the table is empty.
seedIfEmpty();

function rowToJson(r) {
  return {
    id:           r.id,
    name:         r.name,
    description:  r.description,
    storagePerTb: r.storage_per_tb,
    egressPerGb:  r.egress_per_gb,
    classAPer10k: r.class_a_per_10k,
    classBPer10k: r.class_b_per_10k,
    classCPer10k: r.class_c_per_10k,
    classDPer10k: r.class_d_per_10k,
    position:     r.position,
    updatedAt:    r.updated_at,
  };
}

// GET — list — readable by any authenticated user (used to compute customer billing).
router.get('/', requireAuth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM reseller_plans ORDER BY position, id').all();
  res.json({ plans: rows.map(rowToJson) });
});

// PUT — admin-only, CSRF required.
router.put('/:id', requireAuth, requireRole('admin'), requireCsrf, (req, res) => {
  const { id } = req.params;
  const b = req.body || {};

  // Validate / coerce — every numeric must be a finite non-negative number.
  const numericKeys = [
    'storagePerTb', 'egressPerGb',
    'classAPer10k', 'classBPer10k', 'classCPer10k', 'classDPer10k',
  ];
  const values = {};
  for (const k of numericKeys) {
    if (b[k] === undefined) continue;
    const n = Number(b[k]);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: `${k} must be a non-negative number` });
    }
    values[k] = n;
  }
  if (b.description !== undefined) values.description = String(b.description).slice(0, 200);

  const existing = db.prepare('SELECT * FROM reseller_plans WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Plan not found' });

  // Apply only the fields actually provided in the body.
  const merged = {
    ...existing,
    description:      values.description       ?? existing.description,
    storage_per_tb:   values.storagePerTb      ?? existing.storage_per_tb,
    egress_per_gb:    values.egressPerGb       ?? existing.egress_per_gb,
    class_a_per_10k:  values.classAPer10k      ?? existing.class_a_per_10k,
    class_b_per_10k:  values.classBPer10k      ?? existing.class_b_per_10k,
    class_c_per_10k:  values.classCPer10k      ?? existing.class_c_per_10k,
    class_d_per_10k:  values.classDPer10k      ?? existing.class_d_per_10k,
    updated_at:       new Date().toISOString(),
  };

  db.prepare(`
    UPDATE reseller_plans
    SET description=?, storage_per_tb=?, egress_per_gb=?,
        class_a_per_10k=?, class_b_per_10k=?, class_c_per_10k=?, class_d_per_10k=?,
        updated_at=?
    WHERE id=?
  `).run(
    merged.description, merged.storage_per_tb, merged.egress_per_gb,
    merged.class_a_per_10k, merged.class_b_per_10k, merged.class_c_per_10k, merged.class_d_per_10k,
    merged.updated_at, id,
  );

  audit({
    actorId: req.session.user.id,
    action: 'reseller_plan.updated',
    details: { planId: id, changes: values },
    ip: req.ip,
  });

  res.json({ plan: rowToJson(db.prepare('SELECT * FROM reseller_plans WHERE id = ?').get(id)) });
});

export default router;
