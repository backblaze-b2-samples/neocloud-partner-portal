// =============================================================================
// /api/admin/roles — operator-defined roles and their permission sets.
// =============================================================================
// Partner-scope + CSRF, like every other admin surface. Reads need roles:read,
// writes need roles:write, so an operator can hand out visibility of the role
// model without handing out the ability to change it.
//
// Two things are deliberately refused:
//   - deleting a built-in role (the seed would just recreate it, and users.role
//     has a foreign key onto it)
//   - deleting a role that users still hold (the FK would reject it anyway;
//     this turns a 500 into a useful 409)
// =============================================================================

import express from 'express';
import { requireAuth, requirePermission, requirePartnerScope, requireCsrf } from '../middleware/requireAuth.js';
import { ROLES_READ, ROLES_WRITE, ALL_PERMISSIONS, PERMISSION_GROUPS, PERMISSION_LABELS } from '../rbac.js';
import {
  listRoles, findRole, createRole, updateRole, deleteRole,
  roleExists, roleUserCount, isValidRoleId, isValidScope, sanitizePermissions,
} from '../roles.js';
import { audit } from '../audit.js';
import { ssoReferencesToRole } from '../ssoStore.js';

const router = express.Router();
router.use(requireAuth, requirePartnerScope, requireCsrf);

// The permission catalog — drives the checkbox grid in the Roles UI.
router.get('/permissions', requirePermission(ROLES_READ), (_req, res) => {
  res.json({ permissions: ALL_PERMISSIONS, groups: PERMISSION_GROUPS, labels: PERMISSION_LABELS });
});

router.get('/', requirePermission(ROLES_READ), (_req, res) => {
  res.json({ roles: listRoles() });
});

router.get('/:id', requirePermission(ROLES_READ), (req, res) => {
  const role = findRole(req.params.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  res.json({ role });
});

router.post('/', requirePermission(ROLES_WRITE), (req, res) => {
  const { id, name, description, scope, permissions } = req.body || {};
  if (!isValidRoleId(id)) {
    return res.status(400).json({ error: 'id must be lowercase letters, digits, or underscores (2-31 chars)' });
  }
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (!isValidScope(scope)) return res.status(400).json({ error: "scope must be 'partner' or 'customer'" });
  if (roleExists(id)) return res.status(409).json({ error: 'A role with that id already exists' });

  // sanitizePermissions silently drops unknown strings and anything a
  // customer-scope role may not hold. Report that back rather than letting the
  // caller believe a permission was granted when it wasn't.
  const clean = sanitizePermissions(permissions, scope);
  const requested = Array.isArray(permissions) ? permissions : [];
  const rejected = requested.filter((p) => !clean.includes(p));

  const role = createRole({ id, name: name.trim(), description: description || '', scope, permissions: clean });
  audit({
    actorId: req.session.user.id,
    action: 'role.created',
    details: { roleId: id, scope, permissions: clean, rejected },
    ip: req.ip,
  });
  res.status(201).json({ role, rejected });
});

router.put('/:id', requirePermission(ROLES_WRITE), (req, res) => {
  const existing = findRole(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Role not found' });
  const { name, description, permissions } = req.body || {};
  if (name != null && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ error: 'name must be a non-empty string' });
  }

  const clean = permissions === undefined ? undefined : sanitizePermissions(permissions, existing.scope);
  const rejected = permissions === undefined
    ? []
    : (Array.isArray(permissions) ? permissions : []).filter((p) => !clean.includes(p));

  const role = updateRole(req.params.id, {
    name: name != null ? name.trim() : undefined,
    description,
    permissions: clean,
  });
  audit({
    actorId: req.session.user.id,
    action: 'role.updated',
    details: { roleId: req.params.id, permissions: clean, rejected },
    ip: req.ip,
  });
  res.json({ role, rejected });
});

router.delete('/:id', requirePermission(ROLES_WRITE), (req, res) => {
  const role = findRole(req.params.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.builtIn) return res.status(409).json({ error: 'Built-in roles cannot be deleted' });
  const inUse = roleUserCount(req.params.id);
  if (inUse > 0) {
    return res.status(409).json({ error: `Role is assigned to ${inUse} user(s). Reassign them first.` });
  }
  // SSO references would otherwise surface as a raw foreign-key error. Deleting
  // a mapped role silently would also change who the IdP can let in, so say so.
  const refs = ssoReferencesToRole(req.params.id);
  if (refs.mappings > 0 || refs.isDefault) {
    const parts = [];
    if (refs.mappings > 0) parts.push(`${refs.mappings} SSO group mapping(s)`);
    if (refs.isDefault) parts.push('the SSO default role');
    return res.status(409).json({ error: `Role is referenced by ${parts.join(' and ')}. Update the SSO settings first.` });
  }
  deleteRole(req.params.id);
  audit({ actorId: req.session.user.id, action: 'role.deleted', details: { roleId: req.params.id }, ip: req.ip });
  res.json({ ok: true });
});

export default router;
