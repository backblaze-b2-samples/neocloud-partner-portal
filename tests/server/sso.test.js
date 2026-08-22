// Tests for optional OIDC SSO.
//
// Nothing here reaches the network: issuer validation, state handling, the
// one-time exchange code, role resolution, and the account-collision rules are
// all decided before any HTTP call to a provider would happen.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createUser, findByEmail, setAuthSource, localAdminCountExcept } from '../../server/users.js';
import { createSession } from '../../server/auth.js';
import { attachSession } from '../../server/middleware/requireAuth.js';
import ssoRouter from '../../server/routes/sso.js';
import authRouter from '../../server/routes/auth.js';
import adminRouter from '../../server/routes/admin.js';
import { validateIssuerUrl, extractEmail, extractGroups } from '../../server/sso/oidcClient.js';
import { resolveRole } from '../../server/sso/roleResolver.js';
import { setConfig, getConfigPublic, isSsoUsable, createMapping, listMappings, reorderMappings } from '../../server/ssoStore.js';
import { createRole } from '../../server/roles.js';
import { db } from '../../server/db.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachSession);
  app.use('/api/auth/sso', ssoRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  return app;
}
const app = makeApp();

let admin;
beforeAll(() => {
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  process.env.CREDENTIAL_ENCRYPTION_KEY =
    process.env.CREDENTIAL_ENCRYPTION_KEY || 'test-encryption-key-at-least-32-chars-long';
  admin = createUser({ email: 'sso-admin@test.com', passwordHash: 'h', role: 'admin' });
});

beforeEach(() => {
  db.prepare('DELETE FROM sso_group_mappings').run();
  db.prepare('DELETE FROM sso_states').run();
  db.prepare('DELETE FROM sso_exchange_codes').run();
  db.prepare('DELETE FROM sso_config').run();
});

// ---------------------------------------------------------------------------
// Issuer validation (SSRF hardening)
// ---------------------------------------------------------------------------

describe('validateIssuerUrl', () => {
  it('accepts a normal HTTPS issuer', () => {
    expect(() => validateIssuerUrl('https://login.microsoftonline.com/tid/v2.0')).not.toThrow();
  });

  it('rejects plaintext HTTP', () => {
    expect(() => validateIssuerUrl('http://idp.example.com')).toThrow(/HTTPS/);
  });

  it('rejects embedded credentials, query strings, and fragments', () => {
    expect(() => validateIssuerUrl('https://u:p@idp.example.com')).toThrow(/credentials/);
    expect(() => validateIssuerUrl('https://idp.example.com?a=1')).toThrow(/query string/);
    expect(() => validateIssuerUrl('https://idp.example.com#x')).toThrow(/query string|fragment/);
  });

  it('rejects local hosts', () => {
    expect(() => validateIssuerUrl('https://localhost/x')).toThrow(/local host/);
    expect(() => validateIssuerUrl('https://foo.local')).toThrow(/local host/);
  });

  it('rejects private, loopback, and link-local addresses', () => {
    for (const h of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.169.254']) {
      expect(() => validateIssuerUrl(`https://${h}/x`)).toThrow(/private or loopback/);
    }
  });

  it('rejects garbage', () => {
    expect(() => validateIssuerUrl('not a url')).toThrow();
  });

  it('honours the exact-host allowlist when set', () => {
    process.env.SSO_ALLOWED_ISSUER_HOSTS = 'idp.example.com';
    try {
      expect(() => validateIssuerUrl('https://idp.example.com/x')).not.toThrow();
      expect(() => validateIssuerUrl('https://evil.example.com/x')).toThrow(/not in SSO_ALLOWED_ISSUER_HOSTS/);
      // The allowlist is the whole policy — an explicitly allowed host is
      // permitted even if it would otherwise look local.
      process.env.SSO_ALLOWED_ISSUER_HOSTS = 'localhost';
      expect(() => validateIssuerUrl('https://localhost/x')).not.toThrow();
    } finally {
      delete process.env.SSO_ALLOWED_ISSUER_HOSTS;
    }
  });
});

// ---------------------------------------------------------------------------
// Claim extraction
// ---------------------------------------------------------------------------

describe('extractEmail', () => {
  it('accepts a verified address and lowercases it', () => {
    expect(extractEmail({ email: 'Alice@Corp.COM', email_verified: true })).toBe('alice@corp.com');
  });
  it('accepts an absent email_verified (Entra and Google omit it)', () => {
    expect(extractEmail({ email: 'bob@corp.com' })).toBe('bob@corp.com');
  });
  it('rejects an explicitly unverified address', () => {
    expect(extractEmail({ email: 'mallory@corp.com', email_verified: false })).toBeNull();
  });
  it('falls back to preferred_username, and returns null with nothing usable', () => {
    expect(extractEmail({ preferred_username: 'carol@corp.com' })).toBe('carol@corp.com');
    expect(extractEmail({})).toBeNull();
  });
});

describe('extractGroups', () => {
  it('reads the configured claim and stringifies members', () => {
    expect(extractGroups({ groups: ['a', 1] }, 'groups')).toEqual(['a', '1']);
    expect(extractGroups({ roles: ['x'] }, 'roles')).toEqual(['x']);
  });
  it('returns empty for a missing or non-array claim', () => {
    expect(extractGroups({}, 'groups')).toEqual([]);
    expect(extractGroups({ groups: 'nope' }, 'groups')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Role resolution
// ---------------------------------------------------------------------------

describe('resolveRole', () => {
  const baseConfig = {
    enabled: true, issuerUrl: 'https://idp.example.com', clientId: 'cid',
    clientSecret: 'secret', groupsClaim: 'groups', buttonLabel: 'SSO',
  };

  it('takes the first matching mapping in sort order', () => {
    setConfig({ ...baseConfig });
    createMapping({ groupValue: 'g-support', roleId: 'support' });
    createMapping({ groupValue: 'g-manager', roleId: 'manager' });
    const r = resolveRole(['g-manager', 'g-support']);
    expect(r).toMatchObject({ ok: true, roleId: 'support', via: 'mapping' });
  });

  it('respects a reorder', () => {
    setConfig({ ...baseConfig });
    const a = createMapping({ groupValue: 'g-support', roleId: 'support' });
    const b = createMapping({ groupValue: 'g-manager', roleId: 'manager' });
    reorderMappings([b.id, a.id]);
    expect(resolveRole(['g-manager', 'g-support']).roleId).toBe('manager');
  });

  it('falls back to the default role when nothing matches', () => {
    setConfig({ ...baseConfig, defaultRole: 'user' });
    expect(resolveRole(['unknown'])).toMatchObject({ ok: true, roleId: 'user', via: 'default' });
  });

  it('refuses when there is no mapping and no default', () => {
    setConfig({ ...baseConfig });
    expect(resolveRole([])).toEqual({ ok: false, reason: 'no_role' });
  });

  // The foreign key on sso_group_mappings.role_id is the primary guard here —
  // it rejects a dangling mapping outright:
  it('cannot even store a mapping to a non-existent role', () => {
    expect(() =>
      db.prepare("INSERT INTO sso_group_mappings (group_value, role_id, label, sort_order) VALUES ('g','ghost','',0)").run()
    ).toThrow(/FOREIGN KEY/);
  });

  // ...but the resolver still fails closed if one appears anyway (foreign keys
  // off, a restored backup, a direct DB edit), rather than granting something
  // arbitrary.
  it('fails closed on a dangling mapping that bypassed the foreign key', () => {
    setConfig({ ...baseConfig, defaultRole: null });
    db.pragma('foreign_keys = OFF');
    try {
      db.prepare("INSERT INTO sso_group_mappings (group_value, role_id, label, sort_order) VALUES ('g','ghost','',0)").run();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    expect(resolveRole(['g'])).toMatchObject({ ok: false, reason: 'invalid_role' });
  });

  it('refuses a customer-scope role — SSO is partner staff only', () => {
    setConfig({ ...baseConfig });
    createMapping({ groupValue: 'g-cust', roleId: 'customer_readonly' });
    expect(resolveRole(['g-cust'])).toMatchObject({ ok: false, reason: 'invalid_role' });
  });

  it('refuses admin unless allowAdminRole is on', () => {
    setConfig({ ...baseConfig, allowAdminRole: false });
    createMapping({ groupValue: 'g-admin', roleId: 'admin' });
    expect(resolveRole(['g-admin'])).toMatchObject({ ok: false, reason: 'admin_not_allowed' });
  });

  it('allows admin once an operator turns it on', () => {
    setConfig({ ...baseConfig, allowAdminRole: true });
    createMapping({ groupValue: 'g-admin', roleId: 'admin' });
    expect(resolveRole(['g-admin'])).toMatchObject({ ok: true, roleId: 'admin' });
  });

  it('can grant an operator-defined custom role', () => {
    createRole({ id: 'ssocustom', name: 'SSO Custom', scope: 'partner', permissions: ['audit:read'] });
    setConfig({ ...baseConfig });
    createMapping({ groupValue: 'g-custom', roleId: 'ssocustom' });
    expect(resolveRole(['g-custom'])).toMatchObject({ ok: true, roleId: 'ssocustom' });
  });
});

// ---------------------------------------------------------------------------
// Config gating
// ---------------------------------------------------------------------------

describe('/api/auth/sso/status', () => {
  it('reports disabled and leaks no configuration when unset', async () => {
    const res = await request(app).get('/api/auth/sso/status').expect(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.issuerUrl).toBeUndefined();
    expect(res.body.clientId).toBeUndefined();
  });

  it('stays disabled while the config is incomplete', async () => {
    setConfig({ enabled: true, issuerUrl: 'https://idp.example.com', clientId: '', clientSecret: '' });
    expect(isSsoUsable()).toBe(false);
    const res = await request(app).get('/api/auth/sso/status').expect(200);
    expect(res.body.enabled).toBe(false);
  });

  it('reports enabled with the button label once complete', async () => {
    setConfig({
      enabled: true, issuerUrl: 'https://idp.example.com', clientId: 'cid',
      clientSecret: 'shh', buttonLabel: 'Sign in with Acme',
    });
    const res = await request(app).get('/api/auth/sso/status').expect(200);
    expect(res.body).toEqual({ enabled: true, buttonLabel: 'Sign in with Acme' });
  });
});

describe('config PUT preserves omitted fields', () => {
  it('keeps buttonLabel, groupsClaim, and allowAdminRole when they are not sent', () => {
    setConfig({
      enabled: true, issuerUrl: 'https://idp.example.com', clientId: 'cid', clientSecret: 'shh',
      groupsClaim: 'roles', buttonLabel: 'Sign in with Acme', allowAdminRole: true,
    });
    // Simulates the shape a partial update would produce.
    const prev = getConfigPublic();
    setConfig({ ...prev, enabled: false, clientSecret: undefined });
    const after = getConfigPublic();
    expect(after.enabled).toBe(false);
    expect(after.buttonLabel).toBe('Sign in with Acme');
    expect(after.groupsClaim).toBe('roles');
    expect(after.allowAdminRole).toBe(true);
    expect(after.hasClientSecret).toBe(true);   // omitting the secret keeps it
  });
});

describe('/api/auth/sso/login', () => {
  it('400s while SSO is disabled', async () => {
    await request(app).get('/api/auth/sso/login').expect(400);
  });
});

describe('/api/auth/sso/callback', () => {
  beforeEach(() => {
    setConfig({ enabled: true, issuerUrl: 'https://idp.example.com', clientId: 'cid', clientSecret: 'shh' });
  });

  it('redirects with missing_params when the IdP sends nothing useful', async () => {
    const res = await request(app).get('/api/auth/sso/callback').expect(302);
    expect(res.headers.location).toBe('/?sso=1&error=missing_params');
  });

  it('passes an IdP-reported error through', async () => {
    const res = await request(app).get('/api/auth/sso/callback?error=access_denied').expect(302);
    expect(res.headers.location).toContain('error=access_denied');
  });

  it('rejects an unknown state before contacting the provider', async () => {
    const res = await request(app).get('/api/auth/sso/callback?code=x&state=never-issued').expect(302);
    expect(res.headers.location).toBe('/?sso=1&error=invalid_state');
  });

  it('rejects an expired state', async () => {
    const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO sso_states (state, created_at) VALUES (?,?)').run('stale', old);
    const res = await request(app).get('/api/auth/sso/callback?code=x&state=stale').expect(302);
    expect(res.headers.location).toBe('/?sso=1&error=invalid_state');
  });
});

// ---------------------------------------------------------------------------
// One-time exchange code
// ---------------------------------------------------------------------------

describe('/api/auth/sso/exchange', () => {
  let target;
  beforeEach(() => {
    target = findByEmail('exchange-user@test.com')
      || createUser({ email: 'exchange-user@test.com', passwordHash: 'h', role: 'user' });
  });

  // Codes are bound to the browser that started the flow, so a directly-minted
  // code needs a matching nonce and the cookie that carries it.
  const NONCE = 'test-flow-nonce-value';
  const FLOW = `sso_flow=${NONCE}`;
  const mintCode = (code, ageMs = 0) =>
    db.prepare('INSERT INTO sso_exchange_codes (code, user_id, nonce, created_at) VALUES (?,?,?,?)')
      .run(code, target.id, NONCE, new Date(Date.now() - ageMs).toISOString());

  it('rejects a code that was never issued', async () => {
    await request(app).post('/api/auth/sso/exchange').send({ code: 'nope' }).expect(400);
  });

  it('rejects a missing code', async () => {
    await request(app).post('/api/auth/sso/exchange').send({}).expect(400);
  });

  it('creates a session and sets both cookies', async () => {
    mintCode('good-code');
    const res = await request(app).post('/api/auth/sso/exchange').set('Cookie', FLOW).send({ code: 'good-code' }).expect(200);
    const cookies = res.headers['set-cookie'].join(';');
    expect(cookies).toMatch(/sid=/);
    expect(cookies).toMatch(/csrf=/);
    expect(cookies).toMatch(/HttpOnly/);
    expect(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ?').get(target.id).n).toBeGreaterThan(0);
  });

  it('is single-use', async () => {
    mintCode('once');
    await request(app).post('/api/auth/sso/exchange').set('Cookie', FLOW).send({ code: 'once' }).expect(200);
    await request(app).post('/api/auth/sso/exchange').set('Cookie', FLOW).send({ code: 'once' }).expect(400);
  });

  it('rejects a valid code presented without the flow cookie', async () => {
    mintCode('needs-cookie');
    await request(app).post('/api/auth/sso/exchange').send({ code: 'needs-cookie' }).expect(400);
  });

  it('rejects a valid code presented with a different flow cookie', async () => {
    mintCode('wrong-cookie');
    await request(app).post('/api/auth/sso/exchange')
      .set('Cookie', 'sso_flow=some-other-browser-nonce').send({ code: 'wrong-cookie' }).expect(400);
  });

  it('rejects a code older than 60 seconds', async () => {
    mintCode('expired', 61_000);
    await request(app).post('/api/auth/sso/exchange').set('Cookie', FLOW).send({ code: 'expired' }).expect(400);
  });

  it('yields a session that /api/auth/me accepts', async () => {
    mintCode('me-code');
    const res = await request(app).post('/api/auth/sso/exchange').set('Cookie', FLOW).send({ code: 'me-code' }).expect(200);
    const me = await request(app).get('/api/auth/me').set('Cookie', res.headers['set-cookie']).expect(200);
    expect(me.body.user.email).toBe('exchange-user@test.com');
    expect(me.body.user.permissions).toContain('buckets:read');
  });
});

// ---------------------------------------------------------------------------
// Password login is closed to SSO accounts
// ---------------------------------------------------------------------------

describe('password login for SSO accounts', () => {
  it('is refused with the same generic message', async () => {
    const { hashPassword } = await import('../../server/auth.js');
    const hash = await hashPassword('CorrectHorse1');
    const u = createUser({ email: 'federated@test.com', passwordHash: hash, role: 'user' });

    // Still works while the account is local.
    await request(app).post('/api/auth/login')
      .send({ email: 'federated@test.com', password: 'CorrectHorse1' }).expect(200);

    setAuthSource(u.id, 'sso');
    const res = await request(app).post('/api/auth/login')
      .send({ email: 'federated@test.com', password: 'CorrectHorse1' }).expect(401);
    expect(res.body.error).toBe('Invalid credentials');
  });
});

// ---------------------------------------------------------------------------
// Convert to SSO
// ---------------------------------------------------------------------------

describe('POST /api/admin/users/:id/auth-source', () => {
  let sid, csrf;
  beforeAll(() => {
    const s = createSession({ userId: admin.id, ip: '127.0.0.1', userAgent: 'test' });
    sid = s.sid; csrf = s.csrf;
  });
  const post = (path, body) =>
    request(app).post(path).set('Cookie', `sid=${sid}; csrf=${csrf}`).set('X-CSRF-Token', csrf).send(body);

  it('converts a partner user, keeping the same row', async () => {
    const u = createUser({ email: 'convert-me@test.com', passwordHash: 'h', role: 'manager' });
    const res = await post(`/api/admin/users/${u.id}/auth-source`, { authSource: 'sso' }).expect(200);
    expect(res.body.user.id).toBe(u.id);
    expect(res.body.user.authSource).toBe('sso');
    expect(res.body.user.createdAt).toBe(u.created_at);
  });

  it('revokes existing sessions on conversion', async () => {
    const u = createUser({ email: 'convert-sessions@test.com', passwordHash: 'h', role: 'user' });
    createSession({ userId: u.id, ip: '127.0.0.1', userAgent: 'test' });
    expect(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ?').get(u.id).n).toBe(1);
    await post(`/api/admin/users/${u.id}/auth-source`, { authSource: 'sso' }).expect(200);
    expect(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ?').get(u.id).n).toBe(0);
  });

  it('refuses a demo account', async () => {
    const u = createUser({ email: 'someone@demo.com', passwordHash: 'h', role: 'user' });
    await post(`/api/admin/users/${u.id}/auth-source`, { authSource: 'sso' }).expect(403);
  });

  it('refuses a customer user', async () => {
    const u = createUser({ email: 'tenant@test.com', passwordHash: 'h', role: 'customer_admin', accountId: 'acct-1' });
    await post(`/api/admin/users/${u.id}/auth-source`, { authSource: 'sso' }).expect(400);
  });

  it('refuses an invalid value', async () => {
    const u = createUser({ email: 'badvalue@test.com', passwordHash: 'h', role: 'user' });
    await post(`/api/admin/users/${u.id}/auth-source`, { authSource: 'ldap' }).expect(400);
  });

  it('refuses to convert the last local admin, preserving break-glass access', async () => {
    // `admin` is the only active local admin at this point.
    expect(localAdminCountExcept(admin.id)).toBe(0);
    const res = await post(`/api/admin/users/${admin.id}/auth-source`, { authSource: 'sso' }).expect(409);
    expect(res.body.error).toMatch(/last admin/i);
  });

  it('allows it once a second local admin exists', async () => {
    const second = createUser({ email: 'second-admin@test.com', passwordHash: 'h', role: 'admin' });
    await post(`/api/admin/users/${second.id}/auth-source`, { authSource: 'sso' }).expect(200);
    // ...and now the original is once again the last local admin.
    await post(`/api/admin/users/${admin.id}/auth-source`, { authSource: 'sso' }).expect(409);
  });

  it('forces a password reset when converting back to local', async () => {
    const u = createUser({ email: 'back-to-local@test.com', passwordHash: 'h', role: 'user' });
    await post(`/api/admin/users/${u.id}/auth-source`, { authSource: 'sso' }).expect(200);
    const res = await post(`/api/admin/users/${u.id}/auth-source`, { authSource: 'local' }).expect(200);
    expect(res.body.user.authSource).toBe('local');
    expect(res.body.user.mustChangePassword).toBe(true);
  });

  it('refuses a role change on an SSO-managed user', async () => {
    const u = createUser({ email: 'sso-role-locked@test.com', passwordHash: 'h', role: 'user' });
    await post(`/api/admin/users/${u.id}/auth-source`, { authSource: 'sso' }).expect(200);
    const res = await request(app).patch(`/api/admin/users/${u.id}`)
      .set('Cookie', `sid=${sid}; csrf=${csrf}`).set('X-CSRF-Token', csrf)
      .send({ role: 'manager' }).expect(409);
    expect(res.body.error).toMatch(/managed by SSO/i);
  });
});
