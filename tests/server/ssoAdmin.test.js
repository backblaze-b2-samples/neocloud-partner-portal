// Tests for /api/admin/sso — config validation, secret handling, and mappings.
//
// The security-relevant claims here are that the client secret is write-only,
// that an operator cannot half-enable SSO into a broken state, that the issuer
// URL cannot be pointed at an internal address, and that mapping order (which
// decides who gets which role) is under permission control.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createUser } from '../../server/users.js';
import { createSession } from '../../server/auth.js';
import { attachSession } from '../../server/middleware/requireAuth.js';
import ssoAdminRouter from '../../server/routes/ssoAdmin.js';
import { createRole, updateRole } from '../../server/roles.js';
import { getConfigPublic, getDecryptedClientSecret, setConfig } from '../../server/ssoStore.js';
import { resetRateLimits } from '../../server/rateLimit.js';
import { db } from '../../server/db.js';

const app = (() => {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use(attachSession);
  a.use('/api/admin/sso', ssoAdminRouter);
  return a;
})();

const actors = {};
function as(who) {
  const { sid, csrf } = actors[who];
  const auth = (r) => r.set('Cookie', `sid=${sid}; csrf=${csrf}`).set('X-CSRF-Token', csrf);
  return {
    get: (p) => auth(request(app).get(p)),
    put: (p, b) => auth(request(app).put(p)).send(b),
    post: (p, b) => auth(request(app).post(p)).send(b),
    del: (p) => auth(request(app).delete(p)),
  };
}

beforeAll(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY =
    process.env.CREDENTIAL_ENCRYPTION_KEY || 'test-encryption-key-at-least-32-chars-long';
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM sessions').run();

  const mk = (key, email, role, accountId = null) => {
    const u = createUser({ email, passwordHash: 'h', role, accountId });
    const s = createSession({ userId: u.id, ip: '127.0.0.1', userAgent: 'test' });
    actors[key] = { user: u, sid: s.sid, csrf: s.csrf };
  };
  mk('admin', 'ssoadm-admin@test.com', 'admin');
  mk('manager', 'ssoadm-manager@test.com', 'manager');
  mk('tenant', 'ssoadm-tenant@test.com', 'customer_admin', 'acct-9');

  // A partner role that can read settings but not write them.
  createRole({ id: 'settingsviewer', name: 'Settings viewer', scope: 'partner', permissions: ['settings:read'] });
  mk('viewer', 'ssoadm-viewer@test.com', 'settingsviewer');
});

beforeEach(() => {
  resetRateLimits();
  db.prepare('DELETE FROM sso_group_mappings').run();
  db.prepare('DELETE FROM sso_config').run();
});

const VALID = {
  enabled: true,
  issuerUrl: 'https://idp.test.example',
  clientId: 'portal-client',
  clientSecret: 'super-secret',
};

// ---------------------------------------------------------------------------

describe('permission gating', () => {
  it('lets settings:read view the config but not change it', async () => {
    await as('viewer').get('/api/admin/sso/config').expect(200);
    const res = await as('viewer').put('/api/admin/sso/config', VALID).expect(403);
    expect(res.body.missingPermission).toBe('settings:write');
  });

  it('refuses a role with neither permission', async () => {
    await as('manager').get('/api/admin/sso/config').expect(403);
    await as('manager').put('/api/admin/sso/config', VALID).expect(403);
  });

  it('refuses a customer user even though tenancy is separate from permissions', async () => {
    await as('tenant').get('/api/admin/sso/config').expect(403);
  });

  it('requires a CSRF token on writes', async () => {
    const { sid, csrf } = actors.admin;
    await request(app).put('/api/admin/sso/config')
      .set('Cookie', `sid=${sid}; csrf=${csrf}`).send(VALID).expect(403);
  });

  it('refuses an anonymous caller', async () => {
    await request(app).get('/api/admin/sso/config').expect(401);
  });
});

// ---------------------------------------------------------------------------

describe('the client secret is write-only', () => {
  it('never returns it, but reports that one is stored', async () => {
    await as('admin').put('/api/admin/sso/config', VALID).expect(200);
    const res = await as('admin').get('/api/admin/sso/config').expect(200);
    expect(res.body.config.hasClientSecret).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('super-secret');
    expect(res.body.config.clientSecret).toBeUndefined();
  });

  it('stores it encrypted, not in the clear', async () => {
    await as('admin').put('/api/admin/sso/config', VALID).expect(200);
    const row = db.prepare('SELECT encrypted_client_secret FROM sso_config WHERE id = 1').get();
    expect(row.encrypted_client_secret).not.toContain('super-secret');
    expect(getDecryptedClientSecret()).toBe('super-secret');
  });

  it('keeps the stored secret when the field is submitted empty', async () => {
    await as('admin').put('/api/admin/sso/config', VALID).expect(200);
    await as('admin').put('/api/admin/sso/config', { ...VALID, clientSecret: '' }).expect(200);
    expect(getDecryptedClientSecret()).toBe('super-secret');
  });

  it('replaces it when a new value is supplied', async () => {
    await as('admin').put('/api/admin/sso/config', VALID).expect(200);
    await as('admin').put('/api/admin/sso/config', { ...VALID, clientSecret: 'rotated' }).expect(200);
    expect(getDecryptedClientSecret()).toBe('rotated');
  });
});

// ---------------------------------------------------------------------------

describe('config validation', () => {
  it('refuses to enable without an issuer, client id, and secret', async () => {
    const a = await as('admin').put('/api/admin/sso/config', { enabled: true, issuerUrl: '', clientId: '' }).expect(400);
    expect(a.body.error).toMatch(/required to enable/);
    await as('admin').put('/api/admin/sso/config', { enabled: true, issuerUrl: VALID.issuerUrl, clientId: 'x' }).expect(400);
  });

  it('allows saving a disabled, incomplete config as a draft', async () => {
    await as('admin').put('/api/admin/sso/config', { enabled: false, issuerUrl: VALID.issuerUrl, clientId: '' }).expect(200);
    expect(getConfigPublic().enabled).toBe(false);
  });

  it('rejects an issuer that is not HTTPS or points somewhere internal', async () => {
    for (const issuerUrl of [
      'http://idp.test.example',
      'https://localhost/idp',
      'https://127.0.0.1/idp',
      'https://10.0.0.5/idp',
      'https://169.254.169.254/idp',
      'https://user:pw@idp.test.example',
      'https://idp.test.example?next=1',
      'not-a-url',
    ]) {
      const res = await as('admin').put('/api/admin/sso/config', { enabled: false, issuerUrl, clientId: 'x' });
      expect(res.status, `expected 400 for ${issuerUrl}`).toBe(400);
    }
  });

  it('trims a pasted discovery URL down to the issuer', async () => {
    await as('admin').put('/api/admin/sso/config', {
      ...VALID, issuerUrl: 'https://idp.test.example/.well-known/openid-configuration',
    }).expect(200);
    expect(getConfigPublic().issuerUrl).toBe('https://idp.test.example');
  });

  it('rejects a plaintext redirect URI but allows localhost for development', async () => {
    await as('admin').put('/api/admin/sso/config', { ...VALID, redirectUri: 'http://portal.example/cb' }).expect(400);
    await as('admin').put('/api/admin/sso/config', { ...VALID, redirectUri: 'http://localhost:3001/cb' }).expect(200);
    await as('admin').put('/api/admin/sso/config', { ...VALID, redirectUri: 'https://portal.example/cb' }).expect(200);
  });

  it('rejects a default role that is a customer role or does not exist', async () => {
    await as('admin').put('/api/admin/sso/config', { ...VALID, defaultRole: 'customer_admin' }).expect(400);
    await as('admin').put('/api/admin/sso/config', { ...VALID, defaultRole: 'no_such_role' }).expect(400);
    await as('admin').put('/api/admin/sso/config', { ...VALID, defaultRole: 'support' }).expect(200);
  });

  it('records the change in the audit log without recording the secret', async () => {
    db.prepare('DELETE FROM audit_log').run();
    await as('admin').put('/api/admin/sso/config', VALID).expect(200);
    const row = db.prepare("SELECT action, details FROM audit_log WHERE action = 'sso.config.updated'").get();
    expect(row).toBeTruthy();
    expect(row.details).not.toContain('super-secret');
    expect(JSON.parse(row.details).secretChanged).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('the allow-admin-role switch', () => {
  it('defaults to off and persists when turned on', async () => {
    await as('admin').put('/api/admin/sso/config', VALID).expect(200);
    expect(getConfigPublic().allowAdminRole).toBe(false);
    await as('admin').put('/api/admin/sso/config', { ...VALID, allowAdminRole: true }).expect(200);
    expect(getConfigPublic().allowAdminRole).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('group to role mappings', () => {
  beforeEach(async () => {
    await as('admin').put('/api/admin/sso/config', VALID);
  });

  it('creates, lists, updates, and deletes', async () => {
    const created = await as('admin').post('/api/admin/sso/mappings', {
      groupValue: 'grp-ops', roleId: 'support', label: 'Ops',
    }).expect(201);
    const id = created.body.mapping.id;

    const list = await as('admin').get('/api/admin/sso/mappings').expect(200);
    expect(list.body.mappings).toHaveLength(1);

    await as('admin').put(`/api/admin/sso/mappings/${id}`, { roleId: 'manager', label: 'Renamed' }).expect(200);
    const after = await as('admin').get('/api/admin/sso/mappings').expect(200);
    expect(after.body.mappings[0]).toMatchObject({ roleId: 'manager', label: 'Renamed' });

    await as('admin').del(`/api/admin/sso/mappings/${id}`).expect(200);
    const empty = await as('admin').get('/api/admin/sso/mappings').expect(200);
    expect(empty.body.mappings).toHaveLength(0);
  });

  it('refuses a mapping to a customer role or a missing role', async () => {
    const a = await as('admin').post('/api/admin/sso/mappings', { groupValue: 'g', roleId: 'customer_readonly' }).expect(400);
    expect(a.body.error).toMatch(/partner-staff roles/);
    await as('admin').post('/api/admin/sso/mappings', { groupValue: 'g', roleId: 'ghost' }).expect(400);
  });

  it('requires a group value', async () => {
    await as('admin').post('/api/admin/sso/mappings', { groupValue: '   ', roleId: 'support' }).expect(400);
  });

  it('can grant an operator-defined custom role', async () => {
    createRole({ id: 'ssoops', name: 'SSO Ops', scope: 'partner', permissions: ['audit:read'] });
    const res = await as('admin').post('/api/admin/sso/mappings', { groupValue: 'g', roleId: 'ssoops' }).expect(201);
    expect(res.body.mapping.roleId).toBe('ssoops');
  });

  it('404s on an unknown mapping', async () => {
    await as('admin').put('/api/admin/sso/mappings/9999', { label: 'x' }).expect(404);
    await as('admin').del('/api/admin/sso/mappings/9999').expect(404);
  });

  it('reorders, since order decides which role a multi-group user gets', async () => {
    const a = (await as('admin').post('/api/admin/sso/mappings', { groupValue: 'g-a', roleId: 'support' })).body.mapping;
    const b = (await as('admin').post('/api/admin/sso/mappings', { groupValue: 'g-b', roleId: 'manager' })).body.mapping;
    const res = await as('admin').post('/api/admin/sso/mappings/reorder', { orderedIds: [b.id, a.id] }).expect(200);
    expect(res.body.mappings.map((m) => m.groupValue)).toEqual(['g-b', 'g-a']);
  });

  it('rejects a malformed reorder payload', async () => {
    await as('admin').post('/api/admin/sso/mappings/reorder', { orderedIds: 'nope' }).expect(400);
    await as('admin').post('/api/admin/sso/mappings/reorder', { orderedIds: ['a'] }).expect(400);
  });

  it('requires settings:write to mutate mappings', async () => {
    await as('viewer').get('/api/admin/sso/mappings').expect(200);
    await as('viewer').post('/api/admin/sso/mappings', { groupValue: 'g', roleId: 'support' }).expect(403);
  });

  it('removes a role\'s mappings when that role is deleted', async () => {
    createRole({ id: 'temprole', name: 'Temp', scope: 'partner', permissions: ['audit:read'] });
    await as('admin').post('/api/admin/sso/mappings', { groupValue: 'g-temp', roleId: 'temprole' }).expect(201);
    db.prepare("DELETE FROM roles WHERE id = 'temprole'").run();
    const list = await as('admin').get('/api/admin/sso/mappings').expect(200);
    expect(list.body.mappings.find((m) => m.roleId === 'temprole')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('discovery test endpoint', () => {
  it('validates the issuer before attempting any fetch', async () => {
    const res = await as('admin').post('/api/admin/sso/test', { issuerUrl: 'https://127.0.0.1/idp' }).expect(400);
    expect(res.body.error).toMatch(/private or loopback/);
  });

  it('400s when there is no issuer to test', async () => {
    await as('admin').post('/api/admin/sso/test', {}).expect(400);
  });

  it('requires settings:write', async () => {
    await as('viewer').post('/api/admin/sso/test', { issuerUrl: 'https://idp.test.example' }).expect(403);
  });
});
