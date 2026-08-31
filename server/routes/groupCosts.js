// =============================================================================
// /api/admin/group-costs — what the partner PAYS Backblaze, per B2 group.
//
// The two sides of margin live in different places, because they vary along
// different axes:
//
//   cost  — negotiated with Backblaze per partner group, so it belongs to the
//           group (this table). No row means not negotiated: billing falls back
//           to B2 list price.
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
    notes:     r.notes ?? null,
    updatedAt: r.updated_at,
  };
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

  const notes = req.body?.notes !== undefined ? String(req.body.notes).slice(0, 200) : null;
  const now   = new Date().toISOString();

  db.prepare(`
    INSERT INTO group_costs (group_id, cost_per_tb, notes, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(group_id) DO UPDATE SET
      cost_per_tb = excluded.cost_per_tb,
      notes       = excluded.notes,
      updated_at  = excluded.updated_at
  `).run(groupId, costPerTb, notes, now);

  audit({
    actorId: req.session.user.id,
    action: 'group_cost.set',
    details: { groupId, costPerTb },
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
