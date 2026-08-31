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

import crypto from 'node:crypto';
import express from 'express';
import { requireAuth, requirePermission, requirePartnerScope, requireCsrf } from '../middleware/requireAuth.js';
import { PLANS_WRITE } from '../rbac.js';
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

// Seed the defaults exactly once in the lifetime of a database.
//
// This used to seed whenever the table was empty, which meant an operator who
// deleted the sample tiers to make room for their own got them back on the next
// server start. The marker records that we have seeded before; an empty table is
// now taken at face value.
const SEED_MARKER = 'reseller_plans_seeded';

function hasSeeded() {
  return !!db.prepare('SELECT value FROM app_meta WHERE key = ?').get(SEED_MARKER);
}

function markSeeded() {
  db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)')
    .run(SEED_MARKER, new Date().toISOString());
}

// Exported for tests: the module runs this once on import, and the test DB is
// :memory:, so re-importing the module to re-exercise seeding would open a
// different database entirely.
export function seedOnce() {
  if (hasSeeded()) return;

  // Deployments that predate the marker already hold the seeded rows. Record
  // that fact instead of treating them as never-seeded.
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM reseller_plans').get();
  if (n > 0) { markSeeded(); return; }

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
  markSeeded();
}

// Seed once on module load. Safe: only writes the first time this database is
// used, never again — see seedOnce.
seedOnce();

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
    groupId:      r.group_id ?? null,
    position:     r.position,
    updatedAt:    r.updated_at,
  };
}

// Partner scope is asserted here rather than inherited from the /api/admin
// router that happens to be mounted ahead of this one. Relying on mount order
// meant a reordering could quietly expose the partner's own plan pricing to
// tenant users.
router.use(requireAuth, requirePartnerScope);

// Accounts explicitly assigned to each plan. customer_metadata.plan stores the
// plan NAME, so this groups on name. One query for the whole listing rather than
// one per plan, and it is the same query the delete guard uses — what an
// operator sees in the Accounts column is exactly what will block a delete.
function assignedCounts() {
  const rows = db.prepare(`
    SELECT plan, COUNT(*) AS n
    FROM customer_metadata
    WHERE plan IS NOT NULL AND plan != ''
    GROUP BY plan
  `).all();
  return new Map(rows.map((r) => [r.plan, r.n]));
}

function accountsOnPlan(planName) {
  return db.prepare(
    'SELECT account_id, display_name FROM customer_metadata WHERE plan = ? ORDER BY account_id'
  ).all(planName);
}

// Validate / coerce a rate: finite and non-negative, or a 400. Shared by POST
// and PUT so the two cannot drift apart.
const NUMERIC_KEYS = [
  'storagePerTb', 'egressPerGb',
  'classAPer10k', 'classBPer10k', 'classCPer10k', 'classDPer10k',
];

function readRates(body, { required = false } = {}) {
  const values = {};
  for (const k of NUMERIC_KEYS) {
    if (body[k] === undefined) {
      if (required) values[k] = 0;
      continue;
    }
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n < 0) {
      return { error: `${k} must be a non-negative number` };
    }
    values[k] = n;
  }
  return { values };
}

function readName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return { error: 'name is required' };
  if (name.length > 80) return { error: 'name must be 80 characters or fewer' };
  return { name };
}

// GET — list — readable by any partner staff member; the plan tiers are what
// customer billing is computed from, and the sidebar offers this page to all of
// them. Editing still requires plans:write.
router.get('/', (_req, res) => {
  const rows   = db.prepare('SELECT * FROM reseller_plans ORDER BY position, id').all();
  const counts = assignedCounts();
  res.json({
    plans: rows.map((r) => ({ ...rowToJson(r), assignedCount: counts.get(r.name) || 0 })),
  });
});

// POST — create a plan. Admin-only, CSRF required.
router.post('/', requirePermission(PLANS_WRITE), requireCsrf, (req, res) => {
  const b = req.body || {};

  const { name, error: nameErr } = readName(b.name);
  if (nameErr) return res.status(400).json({ error: nameErr });

  const { values, error: rateErr } = readRates(b, { required: true });
  if (rateErr) return res.status(400).json({ error: rateErr });

  if (db.prepare('SELECT id FROM reseller_plans WHERE name = ?').get(name)) {
    return res.status(409).json({ error: `A plan named "${name}" already exists` });
  }

  const id  = `plan-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const { maxPos } = db.prepare('SELECT COALESCE(MAX(position), 0) AS maxPos FROM reseller_plans').get();

  db.prepare(`
    INSERT INTO reseller_plans
      (id, name, description, storage_per_tb, egress_per_gb,
       class_a_per_10k, class_b_per_10k, class_c_per_10k, class_d_per_10k,
       group_id, position, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, name,
    b.description !== undefined ? String(b.description).slice(0, 200) : null,
    values.storagePerTb, values.egressPerGb,
    values.classAPer10k, values.classBPer10k, values.classCPer10k, values.classDPer10k,
    null, maxPos + 1, now,
  );

  audit({
    actorId: req.session.user.id,
    action: 'reseller_plan.created',
    details: { id, name, ...values },
    ip: req.ip,
  });

  const row = db.prepare('SELECT * FROM reseller_plans WHERE id = ?').get(id);
  res.status(201).json({ plan: { ...rowToJson(row), assignedCount: 0 } });
});

// PUT — admin-only, CSRF required.
router.put('/:id', requirePermission(PLANS_WRITE), requireCsrf, (req, res) => {
  const { id } = req.params;
  const b = req.body || {};

  // Validate / coerce — every numeric must be a finite non-negative number.
  const { values, error: rateErr } = readRates(b);
  if (rateErr) return res.status(400).json({ error: rateErr });
  if (b.description !== undefined) values.description = String(b.description).slice(0, 200);

  // Renaming is the dangerous edit: customer_metadata.plan stores the NAME, so
  // a rename that doesn't carry the assignments with it drops every customer on
  // this plan to unassigned — billing at B2 list, zero margin, silently. The
  // cascade below happens in the same transaction as the update.
  let newName = null;
  if (b.name !== undefined) {
    const { name, error: nameErr } = readName(b.name);
    if (nameErr) return res.status(400).json({ error: nameErr });
    newName = name;
  }

  // groupId pins this plan to a B2 partner group: every member of that group
  // bills at this plan unless the account has its own explicit plan. Empty
  // string and null both mean "unpin".
  let groupIdProvided = false;
  if (b.groupId !== undefined) {
    groupIdProvided = true;
    values.group_id = b.groupId === null || String(b.groupId).trim() === ''
      ? null
      : String(b.groupId).trim().slice(0, 64);
  }

  const existing = db.prepare('SELECT * FROM reseller_plans WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Plan not found' });

  // A group resolves to exactly one plan. Reject the collision here rather
  // than letting the unique index throw a 500.
  if (groupIdProvided && values.group_id !== null) {
    const clash = db.prepare(
      'SELECT id, name FROM reseller_plans WHERE group_id = ? AND id != ?'
    ).get(values.group_id, id);
    if (clash) {
      return res.status(409).json({
        error: `Group ${values.group_id} is already pinned to plan "${clash.name}"`,
      });
    }
  }

  // Name is the join key, so a collision would make planByName ambiguous.
  // Caught here rather than surfacing as a 500 from the unique index.
  if (newName !== null && newName !== existing.name) {
    const clash = db.prepare('SELECT id FROM reseller_plans WHERE name = ? AND id != ?').get(newName, id);
    if (clash) return res.status(409).json({ error: `A plan named "${newName}" already exists` });
  }

  // Apply only the fields actually provided in the body.
  const merged = {
    ...existing,
    name:             newName ?? existing.name,
    description:      values.description       ?? existing.description,
    storage_per_tb:   values.storagePerTb      ?? existing.storage_per_tb,
    egress_per_gb:    values.egressPerGb       ?? existing.egress_per_gb,
    class_a_per_10k:  values.classAPer10k      ?? existing.class_a_per_10k,
    class_b_per_10k:  values.classBPer10k      ?? existing.class_b_per_10k,
    class_c_per_10k:  values.classCPer10k      ?? existing.class_c_per_10k,
    class_d_per_10k:  values.classDPer10k      ?? existing.class_d_per_10k,
    group_id:         groupIdProvided ? values.group_id : existing.group_id,
    updated_at:       new Date().toISOString(),
  };

  const stmtUpdate = db.prepare(`
    UPDATE reseller_plans
    SET name=?, description=?, storage_per_tb=?, egress_per_gb=?,
        class_a_per_10k=?, class_b_per_10k=?, class_c_per_10k=?, class_d_per_10k=?,
        group_id=?, updated_at=?
    WHERE id=?
  `);
  const stmtRenameAssignments = db.prepare(
    'UPDATE customer_metadata SET plan = ?, updated_at = ? WHERE plan = ?'
  );

  // One transaction: the plan and the assignments pointing at it move together,
  // or neither does.
  let renamed = 0;
  db.transaction(() => {
    stmtUpdate.run(
      merged.name, merged.description, merged.storage_per_tb, merged.egress_per_gb,
      merged.class_a_per_10k, merged.class_b_per_10k, merged.class_c_per_10k, merged.class_d_per_10k,
      merged.group_id, merged.updated_at, id,
    );
    if (merged.name !== existing.name) {
      renamed = stmtRenameAssignments.run(merged.name, merged.updated_at, existing.name).changes;
    }
  })();

  audit({
    actorId: req.session.user.id,
    action: 'reseller_plan.updated',
    details: {
      planId: id,
      changes: values,
      ...(merged.name !== existing.name
        ? { renamedFrom: existing.name, renamedTo: merged.name, assignmentsMoved: renamed }
        : {}),
    },
    ip: req.ip,
  });

  const row = db.prepare('SELECT * FROM reseller_plans WHERE id = ?').get(id);
  res.json({ plan: { ...rowToJson(row), assignedCount: assignedCounts().get(row.name) || 0 } });
});

// DELETE — admin-only, CSRF required.
//
// Refused while anything depends on the plan. A customer whose plan no longer
// exists resolves to no rate card at all and bills at B2 list — zero margin,
// with nothing on screen to say why. Better to make the operator clear the
// dependency deliberately.
router.delete('/:id', requirePermission(PLANS_WRITE), requireCsrf, (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM reseller_plans WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Plan not found' });

  const assigned = accountsOnPlan(existing.name);
  if (assigned.length) {
    const shown = assigned.slice(0, 10).map((a) => a.display_name || a.account_id);
    const more  = assigned.length - shown.length;
    return res.status(409).json({
      error:
        `"${existing.name}" is assigned to ${assigned.length} ` +
        `account${assigned.length === 1 ? '' : 's'}: ${shown.join(', ')}` +
        `${more > 0 ? `, and ${more} more` : ''}. Reassign them before deleting it.`,
      assignedCount: assigned.length,
      accounts: assigned.map((a) => a.account_id),
    });
  }

  // Group members resolve their plan through this pin and carry no explicit
  // assignment of their own, so they would not show up in the check above.
  if (existing.group_id) {
    return res.status(409).json({
      error:
        `"${existing.name}" is pinned to group ${existing.group_id}, whose members ` +
        `bill at it. Unpin the group before deleting the plan.`,
      groupId: existing.group_id,
    });
  }

  db.prepare('DELETE FROM reseller_plans WHERE id = ?').run(id);

  audit({
    actorId: req.session.user.id,
    action: 'reseller_plan.deleted',
    details: { planId: id, name: existing.name },
    ip: req.ip,
  });

  res.json({ deleted: true });
});

export default router;
