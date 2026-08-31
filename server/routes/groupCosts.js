// =============================================================================
// /api/admin/group-costs — what the partner PAYS Backblaze, per B2 group.
//
// The two sides of margin live in different places, because they vary along
// different axes:
//
//   cost  — negotiated with Backblaze per partner group, so it belongs to the
//           group (this table): storage per TB, egress per GB, and Class A/B/C
//           per 10k. No row, or a null column, means not negotiated: billing
//           falls back to B2 list price for that component.
//   price — what the partner charges, set per reseller plan tier, with
//           per-account overrides (see resellerPlans.js / customerMetadata.js).
//
// Groups themselves come from the B2 Partner API; this is only the local cost
// overlay, keyed on the API's group id.
//
// Endpoints:
//   GET    /            List every stored cost
//   PUT    /:groupId    Set the cost for one group
//   DELETE /:groupId    Clear it (back to B2 list price)
// =============================================================================

import express from 'express';
import { requireAuth, requirePermission, requirePartnerScope, requireCsrf } from '../middleware/requireAuth.js';
import { PLANS_WRITE } from '../rbac.js';
import { db } from '../db.js';
import { audit } from '../audit.js';

const router = express.Router();

// Partner scope asserted here rather than inherited from mount order — these
// are the partner's own purchase rates and must never reach a tenant user.
router.use(requireAuth, requirePartnerScope);

function rowToJson(r) {
  return {
    groupId:   r.group_id,
    costPerTb: r.cost_per_tb,
    // Null means "use B2 list", not "free". At list A/B/C happen to be free, so
    // the two coincide today — they would not if list pricing changed.
    costPerGbEgress:  r.cost_per_gb_egress ?? null,
    costPer10kClassA: r.cost_per_10k_class_a ?? null,
    costPer10kClassB: r.cost_per_10k_class_b ?? null,
    costPer10kClassC: r.cost_per_10k_class_c ?? null,
    notes:     r.notes ?? null,
    updatedAt: r.updated_at,
  };
}

// Optional components — egress and the three transaction classes. Absent or
// empty clears back to B2 list; anything present must be a finite non-negative
// number, since a stored NaN would poison every COGS figure computed from it.
// Storage is handled separately because it is the one required field.
const OPTIONAL_COST_KEYS = [
  'costPerGbEgress',
  'costPer10kClassA', 'costPer10kClassB', 'costPer10kClassC',
];

function readOptionalCosts(body) {
  const out = {};
  for (const k of OPTIONAL_COST_KEYS) {
    const v = body?.[k];
    if (v === undefined || v === null || v === '') { out[k] = null; continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      return { error: `${k} must be a non-negative number` };
    }
    out[k] = n;
  }
  return { values: out };
}

// GET — readable by any partner staff member, same as the plan tiers: the
// Groups screen shows cost alongside revenue, and margin is meaningless
// without it. Editing still requires plans:write.
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM group_costs ORDER BY group_id').all();
  res.json({ costs: rows.map(rowToJson) });
});

// PUT — set one group's cost. Admin-only, CSRF required.
router.put('/:groupId', requirePermission(PLANS_WRITE), requireCsrf, (req, res) => {
  const groupId = String(req.params.groupId || '').trim();
  if (!groupId) return res.status(400).json({ error: 'groupId is required' });

  const raw = req.body?.costPerTb;
  if (raw === undefined || raw === null || raw === '') {
    return res.status(400).json({ error: 'costPerTb is required' });
  }
  const costPerTb = Number(raw);
  if (!Number.isFinite(costPerTb) || costPerTb < 0) {
    return res.status(400).json({ error: 'costPerTb must be a non-negative number' });
  }

  const { values: optional, error: optErr } = readOptionalCosts(req.body);
  if (optErr) return res.status(400).json({ error: optErr });

  const notes = req.body?.notes !== undefined ? String(req.body.notes).slice(0, 200) : null;
  const now   = new Date().toISOString();

  db.prepare(`
    INSERT INTO group_costs
      (group_id, cost_per_tb, cost_per_gb_egress,
       cost_per_10k_class_a, cost_per_10k_class_b, cost_per_10k_class_c, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(group_id) DO UPDATE SET
      cost_per_tb          = excluded.cost_per_tb,
      cost_per_gb_egress   = excluded.cost_per_gb_egress,
      cost_per_10k_class_a = excluded.cost_per_10k_class_a,
      cost_per_10k_class_b = excluded.cost_per_10k_class_b,
      cost_per_10k_class_c = excluded.cost_per_10k_class_c,
      notes                = excluded.notes,
      updated_at           = excluded.updated_at
  `).run(
    groupId, costPerTb, optional.costPerGbEgress,
    optional.costPer10kClassA, optional.costPer10kClassB, optional.costPer10kClassC,
    notes, now,
  );

  audit({
    actorId: req.session.user.id,
    action: 'group_cost.set',
    details: { groupId, costPerTb, ...optional },
    ip: req.ip,
  });

  res.json({ cost: rowToJson(db.prepare('SELECT * FROM group_costs WHERE group_id = ?').get(groupId)) });
});

// DELETE — clear the negotiated cost, reverting that group to B2 list price.
router.delete('/:groupId', requirePermission(PLANS_WRITE), requireCsrf, (req, res) => {
  const { groupId } = req.params;
  const changes = db.prepare('DELETE FROM group_costs WHERE group_id = ?').run(groupId).changes;
  if (!changes) return res.status(404).json({ error: 'No cost stored for this group' });

  audit({
    actorId: req.session.user.id,
    action: 'group_cost.cleared',
    details: { groupId },
    ip: req.ip,
  });

  res.json({ deleted: true });
});

export default router;
