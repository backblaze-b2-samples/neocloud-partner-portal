// =============================================================================
// roleResolver — decide which portal role an SSO login should carry.
// =============================================================================
// First matching group mapping wins, in sort_order; then the configured default
// role; otherwise the login is refused. Refusing by default matters: without it
// an unmapped user from the IdP would silently land on whatever role happened to
// be first, and "manage access through our SSO" would stop meaning anything.
//
// The role is re-resolved on EVERY login, so removing someone from a group in
// the IdP takes effect the next time they sign in.
// =============================================================================

import { listMappings, getConfigPublic } from '../ssoStore.js';
import { findRole } from '../roles.js';

/**
 * @returns {{ ok: true, roleId: string, via: 'mapping'|'default' }}
 *        | {{ ok: false, reason: 'no_role'|'invalid_role'|'admin_not_allowed', roleId?: string }}
 */
export function resolveRole(userGroups) {
  const cfg = getConfigPublic();
  const groups = new Set((userGroups || []).map(String));

  let roleId = null;
  let via = null;

  for (const m of listMappings()) {
    if (groups.has(m.groupValue)) { roleId = m.roleId; via = 'mapping'; break; }
  }
  if (!roleId && cfg.defaultRole) { roleId = cfg.defaultRole; via = 'default'; }
  if (!roleId) return { ok: false, reason: 'no_role' };

  const role = findRole(roleId);
  // A mapping can outlive the role it points at (deleted, or the DB was edited
  // directly). Fail closed rather than falling back to something arbitrary.
  if (!role) return { ok: false, reason: 'invalid_role', roleId };

  // SSO is for partner staff only. A customer-scope role would need an
  // account_id to mean anything, and nothing in the IdP tells us which tenant.
  if (role.scope !== 'partner') return { ok: false, reason: 'invalid_role', roleId };

  // The portal's admin role is absolute — it can read stored B2 credentials and
  // impersonate customers. Granting it from an IdP group is supported, but only
  // when an operator has deliberately turned that on, so a mistyped group id
  // can never mint a portal administrator.
  if (roleId === 'admin' && !cfg.allowAdminRole) {
    return { ok: false, reason: 'admin_not_allowed', roleId };
  }

  return { ok: true, roleId, via };
}
