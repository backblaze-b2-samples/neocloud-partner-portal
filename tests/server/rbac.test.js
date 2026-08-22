// Tests for the permission layer: built-in role seeds, the requirePermission
// gate, the requirePartnerScope tenancy gate, and the roles admin router.
//
// The most important assertions here are the tenancy ones. Permissions and
// tenancy are separate axes, and a customer role legitimately holds
// users:read/users:write for its own team — those must never open the
// partner-wide /api/admin surfaces.
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createUser } from '../../server/users.js';
import { createSession, getSession } from '../../server/auth.js';
import { attachSession } from '../../server/middleware/requireAuth.js';
import adminRouter from '../../server/routes/admin.js';
import rolesRouter from '../../server/routes/roles.js';
import metadataRouter from '../../server/routes/customerMetadata.js';
import resellerPlansRouter from '../../server/routes/resellerPlans.js';
import {
  listRoles, findRole, permissionsFor, roleHasPermission,
  sanitizePermissions, isValidRoleId, createRole,
} from '../../server/roles.js';
import { ALL_PERMISSIONS } from '../../server/rbac.js';
import { createMapping } from '../../server/ssoStore.js';
import { db } from '../../server/db.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachSession);
  // Mount order mirrors server/index.js — the specific path must win.
  app.use('/api/admin/roles', rolesRouter);
  app.use('/api/admin/metadata', metadataRouter);
  app.use('/api/admin', adminRouter);
  return app;
}
const app = makeApp();

const actors = {};
function as(who) {
  const { sid, csrf } = actors[who];
  return {
    get:  (p)    => request(app).get(p).set('Cookie', `sid=${sid}; csrf=${csrf}`),
    post: (p, b) => request(app).post(p).set('Cookie', `sid=${sid}; csrf=${csrf}`).set('X-CSRF-Token', csrf).send(b),
    put:  (p, b) => request(app).put(p).set('Cookie', `sid=${sid}; csrf=${csrf}`).set('X-CSRF-Token', csrf).send(b),
    del:  (p)    => request(app).delete(p).set('Cookie', `sid=${sid}; csrf=${csrf}`).set('X-CSRF-Token', csrf),
  };
}

beforeAll(() => {
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();

  const mk = (email, role, accountId = null) => {
    const u = createUser({ email, passwordHash: 'h', role, accountId });
    const s = createSession({ userId: u.id, ip: '127.0.0.1', userAgent: 'test' });
    actors[role] = { user: u, sid: s.sid, csrf: s.csrf };
    return u;
  };
  mk('rbac-admin@test.com', 'admin');
  mk('rbac-manager@test.com', 'manager');
  mk('rbac-support@test.com', 'support');
  mk('rbac-custadmin@test.com', 'customer_admin', 'acct-rbac');
});

// ---------------------------------------------------------------------------
// Built-in seeds
// ---------------------------------------------------------------------------

describe('built-in roles', () => {
  it('seeds all six with the expected scopes', () => {
    const byId = Object.fromEntries(listRoles().map((r) => [r.id, r]));
    expect(Object.keys(byId).sort()).toEqual(
      ['admin', 'customer_admin', 'customer_readonly', 'manager', 'support', 'user'].sort()
    );
    expect(byId.admin.scope).toBe('partner');
    expect(byId.customer_admin.scope).toBe('customer');
    expect(byId.admin.builtIn).toBe(true);
  });

  it('grants admin every permission in the catalog', () => {
    expect(findRole('admin').permissions.sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('keeps manager and user identical, as they were before the permission layer', () => {
    expect(findRole('manager').permissions).toEqual(findRole('user').permissions);
  });

  it('gives support impersonation but not settings or user management', () => {
    expect(roleHasPermission('support', 'impersonate:start')).toBe(true);
    expect(roleHasPermission('support', 'settings:write')).toBe(false);
    expect(roleHasPermission('support', 'users:read')).toBe(false);
  });

  it('returns an empty set for an unknown role', () => {
    expect(permissionsFor('no_such_role').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// requirePermission
// ---------------------------------------------------------------------------

describe('requirePermission', () => {
  it('allows a holder through', async () => {
    await as('admin').get('/api/admin/users').expect(200);
  });

  it('403s a non-holder and names the missing permission', async () => {
    const res = await as('manager').get('/api/admin/users').expect(403);
    expect(res.body.missingPermission).toBe('users:read');
  });

  it('401s an anonymous caller', async () => {
    await request(app).get('/api/admin/users').expect(401);
  });

  it('keeps the partner-wide customer metadata surface admin-only', async () => {
    await as('admin').get('/api/admin/metadata').expect(200);
    await as('manager').get('/api/admin/metadata').expect(403);
    await as('support').get('/api/admin/metadata').expect(403);
  });
});

// ---------------------------------------------------------------------------
// requirePartnerScope — permissions must not cross tenancy
// ---------------------------------------------------------------------------

describe('requirePartnerScope', () => {
  it('customer_admin holds users:read/users:write for its own team', () => {
    expect(roleHasPermission('customer_admin', 'users:read')).toBe(true);
    expect(roleHasPermission('customer_admin', 'users:write')).toBe(true);
  });

  it('but cannot reach the partner-wide user list with them', async () => {
    await as('customer_admin').get('/api/admin/users').expect(403);
  });

  it('and cannot reach partner-wide customer metadata', async () => {
    await as('customer_admin').get('/api/admin/metadata').expect(403);
  });

  it('and cannot create a portal user', async () => {
    await as('customer_admin')
      .post('/api/admin/users', { email: 'x@test.com', password: 'ValidPass1', role: 'admin' })
      .expect(403);
  });
});

// ---------------------------------------------------------------------------
// Permission sanitising
// ---------------------------------------------------------------------------

describe('sanitizePermissions', () => {
  it('drops strings that are not in the catalog', () => {
    expect(sanitizePermissions(['audit:read', 'not:real', ''], 'partner')).toEqual(['audit:read']);
  });

  it('stops a customer-scope role holding partner permissions', () => {
    expect(sanitizePermissions(['settings:write', 'audit:read', 'buckets:read'], 'customer'))
      .toEqual(['buckets:read']);
  });

  it('de-duplicates and sorts', () => {
    expect(sanitizePermissions(['files:read', 'buckets:read', 'files:read'], 'partner'))
      .toEqual(['buckets:read', 'files:read']);
  });

  it('tolerates non-arrays', () => {
    expect(sanitizePermissions(null, 'partner')).toEqual([]);
  });
});

describe('isValidRoleId', () => {
  it('accepts slugs and rejects anything else', () => {
    expect(isValidRoleId('auditor')).toBe(true);
    expect(isValidRoleId('read_only_2')).toBe(true);
    expect(isValidRoleId('a')).toBe(false);          // too short
    expect(isValidRoleId('Auditor')).toBe(false);    // uppercase
    expect(isValidRoleId('audit-or')).toBe(false);   // hyphen
    expect(isValidRoleId('2fast')).toBe(false);      // leading digit
  });
});

// ---------------------------------------------------------------------------
// Roles admin router
// ---------------------------------------------------------------------------

describe('/api/admin/roles', () => {
  it('lists roles for a roles:read holder and refuses others', async () => {
    const res = await as('admin').get('/api/admin/roles').expect(200);
    expect(res.body.roles.map((r) => r.id)).toContain('admin');
    await as('manager').get('/api/admin/roles').expect(403);
  });

  it('serves the permission catalog', async () => {
    const res = await as('admin').get('/api/admin/roles/permissions').expect(200);
    expect(res.body.permissions).toEqual(ALL_PERMISSIONS);
    expect(res.body.groups.length).toBeGreaterThan(0);
  });

  it('creates a custom role and reports rejected permissions', async () => {
    const res = await as('admin').post('/api/admin/roles', {
      id: 'auditor', name: 'Auditor', scope: 'partner',
      permissions: ['audit:read', 'bogus:perm'],
    }).expect(201);
    expect(res.body.role.permissions).toEqual(['audit:read']);
    expect(res.body.rejected).toEqual(['bogus:perm']);
    expect(res.body.role.builtIn).toBe(false);
  });

  it('rejects a duplicate id and a bad scope', async () => {
    await as('admin').post('/api/admin/roles', { id: 'auditor', name: 'Dup', scope: 'partner' }).expect(409);
    await as('admin').post('/api/admin/roles', { id: 'weird', name: 'W', scope: 'galaxy' }).expect(400);
  });

  it('updates permissions and invalidates the cache immediately', async () => {
    expect(roleHasPermission('auditor', 'users:read')).toBe(false);
    await as('admin').put('/api/admin/roles/auditor', { permissions: ['audit:read', 'users:read'] }).expect(200);
    expect(roleHasPermission('auditor', 'users:read')).toBe(true);
  });

  it('refuses to delete a built-in role', async () => {
    await as('admin').del('/api/admin/roles/admin').expect(409);
  });

  it('refuses to delete a role that users still hold', async () => {
    createRole({ id: 'inuse', name: 'In use', scope: 'partner', permissions: ['audit:read'] });
    createUser({ email: 'holder@test.com', passwordHash: 'h', role: 'inuse' });
    const res = await as('admin').del('/api/admin/roles/inuse').expect(409);
    expect(res.body.error).toMatch(/assigned to 1 user/);
  });

  it('refuses to delete a role an identity provider still grants', async () => {
    createRole({ id: 'ssomapped', name: 'SSO mapped', scope: 'partner', permissions: ['audit:read'] });
    createMapping({ groupValue: 'g-x', roleId: 'ssomapped' });
    const res = await as('admin').del('/api/admin/roles/ssomapped').expect(409);
    expect(res.body.error).toMatch(/SSO group mapping/);
    db.prepare('DELETE FROM sso_group_mappings').run();
    await as('admin').del('/api/admin/roles/ssomapped').expect(200);
  });

  it('deletes an unused custom role', async () => {
    await as('admin').del('/api/admin/roles/auditor').expect(200);
    expect(findRole('auditor')).toBeNull();
  });

  it('requires roles:write to mutate', async () => {
    await as('manager').post('/api/admin/roles', { id: 'nope', name: 'N', scope: 'partner' }).expect(403);
  });

  it('requires a CSRF token', async () => {
    const { sid, csrf } = actors.admin;
    await request(app).post('/api/admin/roles')
      .set('Cookie', `sid=${sid}; csrf=${csrf}`)
      .send({ id: 'nocsrf', name: 'N', scope: 'partner' })
      .expect(403);
  });
});

// ---------------------------------------------------------------------------
// Reseller plans — scope asserted locally, not inherited from mount order
// ---------------------------------------------------------------------------
// This router sits under /api/admin, where another router's middleware happens
// to run first. It must refuse tenant users on its own, so that reordering the
// mounts in server/index.js can never expose partner plan pricing.

describe('reseller plans scope', () => {
  const plansApp = (() => {
    const a = express();
    a.use(express.json());
    a.use(cookieParser());
    a.use(attachSession);
    a.use('/api/admin/reseller-plans', resellerPlansRouter);   // mounted ALONE
    return a;
  })();

  it('lets partner staff read the plan tiers', async () => {
    for (const who of ['admin', 'manager', 'support']) {
      const { sid, csrf } = actors[who];
      await request(plansApp).get('/api/admin/reseller-plans')
        .set('Cookie', `sid=${sid}; csrf=${csrf}`).expect(200);
    }
  });

  it('refuses a tenant user even with no other router in front of it', async () => {
    const { sid, csrf } = actors.customer_admin;
    await request(plansApp).get('/api/admin/reseller-plans')
      .set('Cookie', `sid=${sid}; csrf=${csrf}`).expect(403);
  });

  it('still requires plans:write to edit', async () => {
    const { sid, csrf } = actors.manager;
    await request(plansApp).put('/api/admin/reseller-plans/standard')
      .set('Cookie', `sid=${sid}; csrf=${csrf}`).set('X-CSRF-Token', csrf)
      .send({ name: 'x' }).expect(403);
  });
});

// ---------------------------------------------------------------------------
// Impersonation x permissions
// ---------------------------------------------------------------------------
// getSession() resolves permissions from the EFFECTIVE user, so a staff member
// viewing as a customer sees what that customer sees. Writes stay blocked at
// the requireCsrf chokepoint regardless.

describe('permissions during impersonation', () => {
  it('reports the target\'s permissions, not the actor\'s', () => {
    const target = createUser({
      email: 'imp-target@test.com', passwordHash: 'h', role: 'customer_readonly', accountId: 'acct-imp',
    });
    const staff = actors.admin;
    db.prepare('UPDATE sessions SET impersonating_user_id = ? WHERE id = ?').run(target.id, staff.sid);
    try {
      const sess = getSession(staff.sid);
      expect(sess.user.id).toBe(target.id);
      expect(sess.user.permissions.sort()).toEqual(findRole('customer_readonly').permissions.sort());
      // The admin's own sweeping permissions must not leak through.
      expect(sess.user.permissions).not.toContain('users:write');
      expect(sess.user.permissions).not.toContain('settings:write');
      // The real actor is still identifiable for the audit trail.
      expect(sess.impersonator.email).toBe('rbac-admin@test.com');
    } finally {
      db.prepare('UPDATE sessions SET impersonating_user_id = NULL WHERE id = ?').run(staff.sid);
    }
  });

  it('restores the actor\'s own permissions once impersonation ends', () => {
    const sess = getSession(actors.admin.sid);
    expect(sess.user.permissions).toContain('users:write');
    expect(sess.impersonator).toBeUndefined();
  });

  it('blocks partner-wide routes while impersonating a tenant user', async () => {
    const target = createUser({
      email: 'imp-target2@test.com', passwordHash: 'h', role: 'customer_admin', accountId: 'acct-imp2',
    });
    const staff = actors.admin;
    db.prepare('UPDATE sessions SET impersonating_user_id = ? WHERE id = ?').run(target.id, staff.sid);
    try {
      // Effective identity is a tenant user, so requirePartnerScope refuses.
      await as('admin').get('/api/admin/users').expect(403);
    } finally {
      db.prepare('UPDATE sessions SET impersonating_user_id = NULL WHERE id = ?').run(staff.sid);
    }
  });
});

// ---------------------------------------------------------------------------
// A custom role end-to-end
// ---------------------------------------------------------------------------

describe('custom role end-to-end', () => {
  it('grants exactly the permissions it was given, and nothing more', async () => {
    createRole({ id: 'auditonly', name: 'Audit only', scope: 'partner', permissions: ['audit:read'] });
    const u = createUser({ email: 'auditonly@test.com', passwordHash: 'h', role: 'auditonly' });
    const s = createSession({ userId: u.id, ip: '127.0.0.1', userAgent: 'test' });
    const get = (p) => request(app).get(p).set('Cookie', `sid=${s.sid}; csrf=${s.csrf}`);

    await get('/api/admin/audit').expect(200);   // has audit:read
    await get('/api/admin/users').expect(403);   // lacks users:read
    await get('/api/admin/metadata').expect(403);
  });
});
